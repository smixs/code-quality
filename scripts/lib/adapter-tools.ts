// Runs language-adapter commands and converts their output to the gate's common Finding shape.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Opts } from "./config.ts";
import type { LanguageRoot, ToolAdapter } from "./lang.ts";
import { installHint, toolBinary } from "./tools.ts";
import { check, type Check, type Finding, notedCheck, run } from "./util.ts";

export type AdapterToolKind = "cycles" | "dead" | "form" | "audit";
export type AdapterToolCheck = Check & { adapter: string; kind: AdapterToolKind };
type Runner = typeof run;
type AdapterOptions = { env?: NodeJS.ProcessEnv; roots?: LanguageRoot[]; runner?: Runner };
type Locations = { repo: string; cwd: string };
type RunRequest = {
  o: Opts;
  root: LanguageRoot;
  kind: AdapterToolKind;
  tool: ToolAdapter;
  runner: Runner;
  env?: NodeJS.ProcessEnv;
};
type ParseRequest = Locations & { adapter: string; kind: AdapterToolKind; tool: ToolAdapter; output: string };
type FindingInput = { rule: string; file?: unknown; line?: unknown; msg?: unknown };
type ToolResult = ReturnType<Runner>;
type AuditScan = { findings: Finding[]; packages: number | null };
type AuditScanResult = AuditScan | { check: AdapterToolCheck } | { empty: true };

const KIND_RULE: Record<AdapterToolKind, string> = {
  cycles: "deps/cycle",
  dead: "dead",
  form: "form",
  audit: "deps/audit",
};

const OSV = { tool: "osv-scanner", install: installHint("osv-scanner"), format: "json", command: "" } satisfies ToolAdapter;
const AUDIT_LOCKFILES = new Set([
  "Cargo.lock", "Gemfile.lock", "Pipfile.lock", "bun.lock", "cabal.project.freeze", "composer.lock",
  "conan.lock", "deps.json", "gems.locked", "go.mod", "go.sum", "gradle.lockfile", "mix.lock",
  "package-lock.json", "packages.config", "packages.lock.json", "pdm.lock", "pnpm-lock.yaml", "poetry.lock",
  "pubspec.lock", "pylock.toml", "requirements.txt", "renv.lock", "stack.yaml.lock", "uv.lock", "yarn.lock",
  "buildscript-gradle.lockfile", "verification-metadata.xml",
]);
const AUDIT_SKIP_DIRS = new Set([".git", ".scratch", ".worktrees", ".venv", "build", "dist", "node_modules", "target", "vendor"]);

function tagged(adapter: string, kind: AdapterToolKind, value: Check): AdapterToolCheck {
  return { ...value, adapter, kind };
}

function toolRule(kind: AdapterToolKind, tool: ToolAdapter) {
  if (kind === "cycles" || kind === "audit") return KIND_RULE[kind];
  return `${KIND_RULE[kind]}/${slug(tool.tool)}`;
}

const slug = (name: string) => name.toLowerCase().replace(/^cargo\s+/, "").replace(/[^a-z0-9:+.-]+/g, "-").replace(/^-|-$/g, "");

export function adapterChecks(o: Opts, kinds: AdapterToolKind[], options: AdapterOptions = {}): AdapterToolCheck[] {
  const roots = options.roots ?? o.langs;
  const runner = options.runner ?? run;
  const env = options.env ?? { ...process.env, QG_DIR: o.out };
  const regularKinds = kinds.filter((kind) => kind !== "audit");
  const seen = new Set<string>();
  const checks: AdapterToolCheck[] = [];
  for (const root of roots) {
    for (const kind of regularKinds) {
      const tool = root.adapter[kind];
      const key = `${root.root}\0${kind}\0${tool.command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checks.push(runAdapter({ o, root, kind, tool, runner, env }));
    }
  }
  const grouped = groupNotices(checks);
  return kinds.includes("audit") ? [...grouped, auditCheck(o, runner, env)] : grouped;
}

function auditCheck(o: Opts, runner: Runner, env?: NodeJS.ProcessEnv): AdapterToolCheck {
  if (!o.toml.security.audit) return tagged("osv", "audit", check("deps/audit", [], "", "disabled by [security]"));
  const lockfiles = auditLockfiles(o.repo);
  if (!lockfiles.length) return auditNotRun("osv-scanner: no packages found");
  const scans: AuditScan[] = [];
  for (const lockfile of lockfiles) {
    const scan = scanLockfile({ repo: o.repo, overrides: o.toml.tools, runner, env }, lockfile);
    if ("check" in scan) return scan.check;
    if ("empty" in scan) continue;
    scans.push(scan);
  }
  if (!scans.length) return auditNotRun("osv-scanner: no packages found");
  const findings = uniqueFindings(scans.flatMap((scan) => scan.findings));
  const packages = scans.every((scan) => scan.packages !== null) ? scans.reduce((sum, scan) => sum + scan.packages!, 0) : null;
  const count = packages === null ? "package count unavailable" : `${packages} packages`;
  return tagged("osv", "audit", notedCheck("deps/audit", findings, "", [`deps/audit: ${findings.length} finding(s) (${count}, osv-scanner)`]));
}

type ScanContext = { repo: string; overrides: Record<string, string>; runner: Runner; env?: NodeJS.ProcessEnv };

function scanLockfile(context: ScanContext, lockfile: string): AuditScanResult {
  const { repo, overrides, runner, env } = context;
  const absolute = join(repo, lockfile);
  const cwd = dirname(absolute);
  const result = runner(toolBinary("osv-scanner", overrides), ["scan", "source", "--format", "json", "-L", basename(lockfile)], cwd, { timeout: 600_000, env });
  if (missingTool(result.code, result.err)) return { check: missingCheck({ adapter: "osv", kind: "audit", name: "deps/audit", rule: "deps/audit", tool: OSV }) };
  const skipped = auditSkipReason(result);
  if (skipped === "packages") return { empty: true };
  if (skipped === "database") return { check: auditNotRun("OSV database unavailable") };
  try {
    const findings = parseOsv(result.out, { repo, cwd });
    if (!acceptedResult("audit", result.code, findings)) return { check: auditError(result) };
    return { findings, packages: scannedPackages(result.err) };
  } catch (error) {
    return { check: tagged("osv", "audit", check("deps/audit", [], `osv-scanner: ${(error as Error).message}`)) };
  }
}

function auditLockfiles(repo: string) {
  const listed = run("git", ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard"], repo);
  if (listed.code === 0) return listed.out.split("\n").filter((file) => file && existsSync(join(repo, file)) && AUDIT_LOCKFILES.has(basename(file))).sort();
  return walkedLockfiles(repo);
}

function walkedLockfiles(repo: string) {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const file = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory() && !AUDIT_SKIP_DIRS.has(entry.name)) visit(file);
      else if (entry.isFile() && AUDIT_LOCKFILES.has(entry.name)) found.push(file);
    }
  };
  visit(".");
  return found.sort();
}

function auditSkipReason(result: ToolResult) {
  if (result.out.trim()) return "";
  if (result.code === 128 && /no package sources found/i.test(result.err)) return "packages";
  if (/unable to fetch (?:the )?osv database|network|offline|timed? out|connection|tls|lookup/i.test(result.err)) return "database";
  return "";
}

function auditNotRun(reason: string) {
  return tagged("osv", "audit", notedCheck("deps/audit", [], "", [`not run: deps/audit (${reason})`]));
}

function auditError(result: ToolResult) {
  return tagged("osv", "audit", check("deps/audit", [], `osv-scanner exit ${result.code}: ${shortError(result.err || result.out)}`));
}

function scannedPackages(stderr: string) {
  const counts = [...stderr.matchAll(/found\s+(\d+)\s+packages?\b/gi)].map((match) => Number(match[1]));
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
}

function groupNotices(checks: AdapterToolCheck[]) {
  const counts = new Map<string, number>();
  for (const notice of checks.flatMap((item) => item.notices)) counts.set(notice, (counts.get(notice) ?? 0) + 1);
  const printed = new Set<string>();
  return checks.map((item) => ({ ...item, notices: item.notices.flatMap((notice) => {
    if (printed.has(notice)) return [];
    printed.add(notice);
    return [rootCount(notice, counts.get(notice) ?? 1)];
  }) }));
}

function rootCount(notice: string, count: number) {
  return notice.endsWith(")") ? `${notice.slice(0, -1)}; roots: ${count})` : `${notice}; roots: ${count}`;
}

function runAdapter(request: RunRequest): AdapterToolCheck {
  const { o, root, kind, tool, runner, env } = request;
  const name = `${root.adapter.id}/${kind}`;
  const cwd = root.root === "." ? o.repo : join(o.repo, root.root);
  const result = runner("sh", ["-c", tool.command], cwd, { timeout: 600_000, env });
  const rule = toolRule(kind, tool);
  if (missingTool(result.code, result.err)) return missingCheck({ adapter: root.adapter.id, kind, name, rule, tool });
  return parsedCheck(request, name, cwd, result);
}

function parsedCheck(request: RunRequest, name: string, cwd: string, result: ToolResult): AdapterToolCheck {
  const { o, root, kind, tool } = request;
  try {
    const output = adapterOutput(tool, result.out, cwd, request.env?.QG_DIR ?? o.out);
    const normal = parseAdapterOutput({ adapter: root.adapter.id, kind, tool, output, repo: o.repo, cwd });
    const recovered = root.adapter.id === "go" && kind === "form" ? unsuppressedGocyclo(request, cwd) : [];
    const findings = uniqueFindings([...normal, ...recovered]);
    if (acceptedResult(kind, result.code, findings)) return tagged(root.adapter.id, kind, check(name, findings));
    return tagged(root.adapter.id, kind, check(name, [], `${tool.tool} exit ${result.code}: ${shortError(result.err || result.out)}`));
  } catch (error) {
    return tagged(root.adapter.id, kind, check(name, [], `${tool.tool}: ${(error as Error).message}`));
  }
}

// gocyclo's //gocyclo:ignore removes a function from its output. Recheck only files with that
// directive through a temporary copy; the ordinary scan still owns every other file.
function unsuppressedGocyclo(request: RunRequest, cwd: string): Finding[] {
  const { o, runner, env } = request;
  const listed = run("git", ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], o.repo);
  if (listed.code !== 0) throw new Error(`gocyclo source list: ${shortError(listed.err)}`);
  const copy = { dir: "", aliases: new Map<string, string>() };
  try {
    for (const file of listed.out.split("\0").filter((name) => name.endsWith(".go"))) {
      copyGocycloSource(o, cwd, file, copy);
    }
    if (!copy.dir) return [];
    const files = [...copy.aliases.keys()].map((file) => join(copy.dir, file));
    const result = runner("gocyclo", ["-over", "10", ...files], cwd, { timeout: 600_000, env });
    const findings = parseGocyclo(result.out, { repo: copy.dir, cwd: copy.dir }).map((item) => ({ ...item, file: copy.aliases.get(item.file) ?? item.file }));
    if (!acceptedResult("form", result.code, findings)) throw new Error(`gocyclo recheck exit ${result.code}: ${shortError(result.err || result.out)}`);
    return findings;
  } finally {
    if (copy.dir) rmSync(copy.dir, { recursive: true, force: true });
  }
}

function copyGocycloSource(o: Opts, cwd: string, file: string, copy: { dir: string; aliases: Map<string, string> }) {
  const original = join(o.repo, file);
  const withinRoot = relative(cwd, original);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot) || !existsSync(original)) return;
  const source = readFileSync(original, "utf8");
  const neutral = source.replace(/^([ \t]*\/\/[ \t]*)gocyclo:ignore\b/gm, "$1gocyclo:xxxxxx");
  if (neutral === source) return;
  if (!copy.dir) {
    mkdirSync(o.out, { recursive: true });
    copy.dir = mkdtempSync(join(o.out, "gocyclo-scan-"));
  }
  const target = join(copy.dir, withinRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, neutral);
  copy.aliases.set(withinRoot, file);
}

function acceptedResult(kind: AdapterToolKind, code: number, findings: Finding[]) {
  if (findings.length) return true;
  if (code === 0) return true;
  return kind === "audit" && code === 1;
}

function missingCheck(input: { adapter: string; kind: AdapterToolKind; name: string; rule: string; tool: ToolAdapter }) {
  const { adapter, kind, name, rule, tool } = input;
  const notice = `not run: ${rule} (${tool.tool} not found: ${tool.install})`;
  return tagged(adapter, kind, notedCheck(name, [], "", [notice]));
}

function missingTool(code: number, error: string) {
  const text = error.toLowerCase();
  if (code === 127 && /not found|no such file|executable/.test(text)) return true;
  return code !== 0 && /no such command|component.+not installed|command not found|executable.+not found/.test(text);
}
const shortError = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 240) || "no output";

// A tool that writes SARIF to a file names it in its command; $QG_DIR there is the report directory.
function adapterOutput(tool: ToolAdapter, stdout: string, cwd: string, outDir: string) {
  if (stdout.trim() || tool.format !== "sarif") return stdout;
  const match = /(?:sarif:|ErrorLog=)?([^\s:=]+\.sarif)\b/i.exec(tool.command);
  const named = match ? match[1].replace(/\$QG_DIR|\$\{QG_DIR\}/g, outDir) : "";
  const path = named ? resolve(cwd, named) : "";
  return path && existsSync(path) ? readFileSync(path, "utf8") : stdout;
}

function parseAdapterOutput(request: ParseRequest): Finding[] {
  const { adapter, kind, tool, output, repo, cwd } = request;
  const locations = { repo, cwd };
  if (tool.format === "sarif") return parseSarifWithLocations(output, KIND_RULE[kind], locations);
  const specific = SPECIFIC_PARSERS[`${adapter}:${kind}`];
  if (specific) return specific(output, locations);
  if (kind === "audit") return parseOsv(output, locations);
  if (tool.format === "json" || tool.format === "jsonl") return parseGenericJson(output, KIND_RULE[kind], locations);
  return parseText(output, toolRule(kind, tool), locations);
}

type SpecificParser = (text: string, locations: Locations) => Finding[];
const SPECIFIC_PARSERS: Record<string, SpecificParser> = {
  "go:cycles": parseGoList,
  "go:dead": parseGoDeadcode,
  "go:form": parseGocyclo,
  "rust:dead": parseCargoMachete,
  "rust:form": parseClippy,
};

function normalizedFile(raw: unknown, repo: string, cwd: string) {
  const file = decodedPath(String(raw ?? ".").replace(/^file:\/\//, ""));
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = normalize(relative(repo, absolute));
  return rel && !rel.startsWith("..") ? rel : normalize(file).replace(/^\.\//, "");
}

function decodedPath(file: string) {
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
}

function finding(locations: Locations, input: FindingInput): Finding {
  const { rule, file = ".", line = 0, msg = rule } = input;
  return { rule, file: normalizedFile(file, locations.repo, locations.cwd), line: Number(line) || 0, msg: String(msg || rule) };
}

export function parseSarif(text: string, prefix: string, repo: string, cwd = repo): Finding[] {
  return parseSarifWithLocations(text, prefix, { repo, cwd });
}

function parseSarifWithLocations(text: string, prefix: string, locations: Locations): Finding[] {
  const value = JSON.parse(text);
  if (!Array.isArray(value.runs)) throw new Error("SARIF output has no runs array");
  return value.runs.flatMap((run: any) => rows(run.results).map((result) => sarifFinding(result, prefix, locations)));
}

function sarifFinding(result: any, prefix: string, locations: Locations) {
  const physical = result.locations?.[0]?.physicalLocation ?? {};
  return finding(locations, {
    rule: fixedRule(prefix) ? prefix : `${prefix}/${result.ruleId ?? "finding"}`,
    file: physical.artifactLocation?.uri,
    line: physical.region?.startLine,
    msg: first(result.message?.text, result.message?.markdown),
  });
}

const fixedRule = (prefix: string) => prefix === "deps/cycle" || prefix === "deps/audit";
const rows = (value: unknown): any[] => Array.isArray(value) ? value : [];
const first = (...values: any[]) => values.find((value) => value != null);

function parseJsonValues(text: string): any[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) ? value : [value];
  } catch {
    return JSON.parse(`[${trimmed.replace(/}\s*{/g, "},{")}]`);
  }
}

function parseGoList(text: string, locations: Locations) {
  const findings = parseJsonValues(text).flatMap((pkg) => goErrors(pkg).flatMap((error) => goCycle(error, locations)));
  return uniqueFindings(findings);
}

function goErrors(pkg: any) {
  const errors = [...rows(first(pkg.DepsErrors, pkg.depsErrors))];
  const own = first(pkg.Error, pkg.error);
  if (own) errors.push(own);
  return errors;
}

function goCycle(error: any, locations: Locations): Finding[] {
  const stack = rows(first(error.ImportStack, error.importStack));
  const message = first(error.Err, error.err, "import cycle");
  if (!stack.length && !/import cycle/i.test(message)) return [];
  const detail = stack.length ? stack.join(" -> ") : message;
  return [finding(locations, { rule: "deps/cycle", file: "go.mod", msg: `import cycle: ${detail}` })];
}

function parseGoDeadcode(text: string, locations: Locations) {
  return parseJsonValues(text).flatMap((pkg) => rows(first(pkg.Funcs, pkg.funcs)).map((fn) => deadcodeFinding(pkg, fn, locations)));
}

function deadcodeFinding(pkg: any, fn: any, locations: Locations) {
  const position = first(fn.Position, fn.position, {});
  const owner = first(pkg.Path, pkg.path, pkg.Name, "package");
  return finding(locations, {
    rule: "dead/deadcode",
    file: first(position.File, position.file),
    line: first(position.Line, position.line),
    msg: `${owner}.${first(fn.Name, fn.name)} is unreachable`,
  });
}

function parseGocyclo(text: string, locations: Locations) {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    const match = /^(\d+)\s+\S+\s+(\S+)\s+(.+):(\d+):(\d+)$/.exec(line.trim());
    return match ? [finding(locations, { rule: "form/gocyclo", file: match[3], line: match[4], msg: `${match[2]} has complexity ${match[1]}` })] : [];
  });
}

function parseCargoMachete(text: string, locations: Locations) {
  const value = JSON.parse(text);
  return (value.crates ?? []).flatMap((crate: any) => (crate.unused ?? []).map((dep: string) =>
    finding(locations, { rule: "dead/cargo-machete", file: crate.manifest_path ?? "Cargo.toml", msg: `${crate.package_name ?? "crate"}: unused dependency ${dep}` })));
}

function parseClippy(text: string, locations: Locations) {
  return parseJsonValues(text).flatMap((row) => clippyFinding(row, locations));
}

function clippyFinding(row: any, locations: Locations): Finding[] {
  if (row.reason !== "compiler-message") return [];
  const message = row.message;
  const code = message?.code?.code;
  if (!message || !String(code ?? "").startsWith("clippy::")) return [];
  const spans = rows(message.spans);
  const span = spans.find((item: any) => item.is_primary) ?? spans[0] ?? {};
  return [finding(locations, { rule: `form/${code}`, file: span.file_name, line: span.line_start, msg: message.message })];
}

function parseOsv(text: string, locations: Locations) {
  const value = JSON.parse(text);
  if (!Array.isArray(value.results)) throw new Error("OSV output has no results array");
  return uniqueFindings(value.results.flatMap((result: any) => osvResult(result, locations)));
}

function osvResult(result: any, locations: Locations) {
  return rows(result.packages).flatMap((item) => rows(item.vulnerabilities).map((vulnerability) => osvFinding(result, item, vulnerability, locations)));
}

function osvFinding(result: any, item: any, vulnerability: any, locations: Locations) {
  const pkg = item.package ?? {};
  return finding(locations, {
    rule: "deps/audit",
    file: result.source?.path,
    msg: `${pkg.name ?? "package"}@${pkg.version ?? "unknown"}: ${vulnerability.id ?? "vulnerability"}`,
  });
}

function parseGenericJson(text: string, prefix: string, locations: Locations) {
  const out: Finding[] = [];
  const context = { prefix, locations, out };
  for (const value of parseJsonValues(text)) collectGeneric(value, context);
  return uniqueFindings(out);
}

type GenericContext = { prefix: string; locations: Locations; out: Finding[] };

function collectGeneric(value: unknown, context: GenericContext) {
  if (Array.isArray(value)) return value.forEach((item) => collectGeneric(item, context));
  if (!isObject(value)) return;
  const item = value as Record<string, any>;
  const parsed = genericFinding(item, context);
  if (parsed) context.out.push(parsed);
  Object.values(item).filter(isObject).forEach((child) => collectGeneric(child, context));
}

function genericFinding(item: Record<string, any>, context: GenericContext) {
  const message = typeof item.message === "string" ? item.message : first(item.reason, item.description);
  const file = first(item.file, item.filePath, item.filename, item.path, item.location?.file);
  if (!message || !file) return null;
  const id = first(item.ruleId, item.rule, item.code, item.id, "finding");
  const rule = context.prefix === "deps/cycle" ? context.prefix : `${context.prefix}/${id}`;
  return finding(context.locations, { rule, file, line: first(item.line, item.lineNumber, item.location?.line, item.location?.row), msg: message });
}

const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object";

function parseText(text: string, rule: string, locations: Locations) {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    const match = /^(.+?):(\d+)(?::\d+)?:\s*(.+)$/.exec(line.trim());
    if (match) return [finding(locations, { rule, file: match[1], line: match[2], msg: match[3] })];
    if (rule === "deps/cycle" && /cycle|circular/i.test(line)) return [finding(locations, { rule, msg: line.trim() })];
    return [];
  });
}

function uniqueFindings(findings: Finding[]) {
  return [...new Map(findings.map((item) => [`${item.rule}\0${item.file}\0${item.line}\0${item.msg}`, item])).values()];
}

export function adapterFindingKey(item: Finding, adapter: string, kind: AdapterToolKind) {
  return `${adapter}\0${kind}\0${item.rule}\0${item.file}\0${item.line}\0${item.msg}`;
}

export function ratchetAdapterChecks(checks: AdapterToolCheck[], known: string[] | null): AdapterToolCheck[] {
  if (known === null) return checks.map((item, index) => ({
    ...item,
    findings: [],
    notices: index ? item.notices : [...item.notices, "baseline: no adapter tool list; run --update-baseline after updating code-quality; adapter findings not judged"],
  }));
  const baseline = new Set(known);
  return checks.map((item) => ({
    ...item,
    findings: item.findings.filter((entry) => !baseline.has(adapterFindingKey(entry, item.adapter, item.kind))),
  }));
}

export const adapterFindingKeys = (checks: AdapterToolCheck[]) => checks.flatMap((item) => item.findings.map((entry) => adapterFindingKey(entry, item.adapter, item.kind)));
