// Supply-chain checks that do not need CI: committed-secret history, release age for changed
// lock entries, new direct dependencies, and cached package audits.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Opts } from "./config.ts";
import type { Changes, FileDiff } from "./diff.ts";
import { redactSensitiveText } from "./text.ts";
import { installHint, toolBinary } from "./tools.ts";
import { bypassNote, check, type Check, type Finding, notedCheck, run } from "./util.ts";

type CmdResult = ReturnType<typeof run>;
export type SecurityDeps = { run: typeof run; now: () => number };
const REAL: SecurityDeps = { run, now: Date.now };
const OFFLINE = /(offline|ENETUNREACH|ENETDOWN|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network|could not resolve|failed to connect|fetch failed)/i;
const AUDIT_OFFLINE = /(ENOTFOUND|ECONNREFUSED|ETIMEDOUT)/i;
const LOCK_FILE = /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|uv\.lock|poetry\.lock)$/;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml)$/;

// ---- gitleaks

type GitleaksFinding = Record<string, unknown> & { File?: string; StartLine?: number; RuleID?: string; Commit?: string };

export function gitleaksCheck(o: Opts, deps: SecurityDeps = REAL): Check {
  const unavailable = gitleaksUnavailable(o, deps);
  if (unavailable) return unavailable;
  const report = join(o.out, "gitleaks.json");
  mkdirSync(o.out, { recursive: true });
  rmSync(report, { force: true });
  const result = deps.run(toolBinary("gitleaks", o.toml.tools), ["git", `--log-opts=${o.base}..HEAD`, "--report-format", "json", "--report-path", report, "--redact", "--exit-code", "1"], o.repo);
  if (result.code !== 0 && result.code !== 1) {
    rmSync(report, { force: true });
    return check("secret/gitleaks", [], `gitleaks git: ${commandError(result)}`);
  }
  const parsed = readGitleaks(report);
  rmSync(report, { force: true });
  if (typeof parsed === "string") return check("secret/gitleaks", [], parsed);
  const accepted = parsed.map((item) => ({ item, reason: gitleaksAllowReason(o, item) })).filter((entry) => entry.reason);
  const allowed = new Set(accepted.map((entry) => entry.item));
  const findings = parsed.filter((item) => !allowed.has(item)).map(gitleaksFinding);
  const notices = accepted.map((entry) => bypassNote("secret/gitleaks", "inline", redactSensitiveText(entry.reason)));
  if (result.code === 1 && !findings.length && !parsed.length) return check("secret/gitleaks", [], "gitleaks exited 1 without report findings");
  return notedCheck("secret/gitleaks", findings, "", notices);
}

function gitleaksUnavailable(o: Opts, deps: SecurityDeps) {
  if (!o.toml.security.gitleaks) return check("secret/gitleaks", [], "", "disabled by [security]");
  const version = deps.run(toolBinary("gitleaks", o.toml.tools), ["version"], o.repo);
  if (missingBinary(version)) return notedCheck("secret/gitleaks", [], "", [`secret/gitleaks: not installed (${installHint("gitleaks", o.toml.tools)})`]);
  if (version.code !== 0) return check("secret/gitleaks", [], `gitleaks version: ${commandError(version)}`);
  return null;
}

const missingBinary = (r: CmdResult) => r.code === -1 && /(ENOENT|not found)/i.test(`${r.err} ${r.out}`);
function commandError(r: CmdResult) {
  const message = r.err || r.out || `exit ${r.code}`;
  return redactSensitiveText(message.trim()).slice(0, 300);
}

function readGitleaks(path: string): GitleaksFinding[] | string {
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value : "gitleaks report is not a JSON array";
  } catch (e) {
    return `cannot parse gitleaks report: ${(e as Error).message}`;
  }
}

function gitleaksAllowReason(o: Opts, item: GitleaksFinding) {
  const embedded = Object.values(item).filter((value): value is string => typeof value === "string").map(gitleaksMarkerReason).find(Boolean);
  if (embedded) return embedded;
  const file = typeof item.File === "string" ? join(o.repo, item.File) : "";
  if (!file || !existsSync(file) || typeof item.StartLine !== "number") return "";
  return gitleaksMarkerReason(readFileSync(file, "utf8").split("\n")[item.StartLine - 1] ?? "");
}

const gitleaksMarkerReason = (text: string) => /(?:^|\s)gitleaks:allow\s+(\S.*)$/.exec(text)?.[1].trim() ?? "";

function gitleaksFinding(item: GitleaksFinding): Finding {
  const file = typeof item.File === "string" ? item.File : ".";
  const line = typeof item.StartLine === "number" ? item.StartLine : 0;
  const rule = typeof item.RuleID === "string" ? item.RuleID : "secret";
  const commit = typeof item.Commit === "string" && item.Commit ? ` in ${item.Commit.slice(0, 12)}` : "";
  return { rule: "secret/gitleaks", file, line, msg: `${rule}${commit}` };
}

// ---- changed lock entries and release age

type Registry = "npm" | "pypi";
type LockRecord = { name: string; version: string; line: number; end: number; registry: Registry; file?: string };
type PackageLockRecord = LockRecord & { registryBacked: boolean };
type PackageLockState = { current: PackageLockRecord | null; packagesIndent: number; end: number; out: LockRecord[] };
type AgeCache = { version: 1; published: Record<string, string> };
type Published = { date?: string; offline?: true; error?: string };
type AgeState = { cache: AgeCache; findings: Finding[]; errors: string[]; changed: boolean; offline: boolean };

export function lockAgeCheck(o: Opts, ch: Changes, deps: SecurityDeps = REAL): Check {
  const records = changedLockRecords(o, ch);
  if (!records.length || o.toml.thresholds.min_release_age_days <= 0) return check("deps/lock-age", []);
  const path = join(o.out, "pkg-age.json");
  const state: AgeState = { cache: readAgeCache(path), findings: [], errors: [], changed: false, offline: false };
  for (const record of records) if (checkRecordAge(o, record, state, deps)) break;
  if (state.changed) writeJson(path, state.cache);
  const notices = state.offline ? ["deps/lock-age: not checked (offline)"] : [];
  return { name: "deps/lock-age", findings: state.findings, error: state.errors.join("; "), note: "", notices };
}

function checkRecordAge(o: Opts, record: LockRecord, state: AgeState, deps: SecurityDeps) {
  const key = `${record.registry}:${record.name}@${record.version}`;
  const result = state.cache.published[key] ? { date: state.cache.published[key] } : publishedAt(record, o, deps);
  if (result.offline) {
    state.offline = true;
    return true;
  }
  if (result.error || !result.date) {
    state.errors.push(`${record.name}@${record.version}: ${result.error || "publication date missing"}`);
    return false;
  }
  if (!state.cache.published[key]) {
    state.cache.published[key] = result.date;
    state.changed = true;
  }
  const finding = ageFinding(o, record, result.date, deps.now());
  if (finding) state.findings.push(finding);
  return false;
}

function changedLockRecords(o: Opts, ch: Changes) {
  const records: LockRecord[] = [];
  for (const [file, diff] of ch) {
    if (!LOCK_FILE.test(file) || diff.deleted || !existsSync(join(o.repo, file))) continue;
    const parsed = parseLock(file, readFileSync(join(o.repo, file), "utf8"));
    records.push(...parsed.filter((record) => recordChanged(diff, record)).map((record) => ({ ...record, file })));
  }
  const unique = new Map(records.map((record) => [`${record.registry}:${record.name}@${record.version}`, record]));
  return [...unique.values()];
}

function recordChanged(diff: FileDiff, record: LockRecord) {
  for (const line of diff.added.keys()) if (line >= record.line && line <= record.end) return true;
  return false;
}

function parseLock(file: string, text: string): LockRecord[] {
  const name = basename(file);
  if (name === "package-lock.json") return parsePackageLock(text);
  if (name === "bun.lock") return parseBunLock(text);
  if (name === "pnpm-lock.yaml") return parsePnpmLock(text);
  return parsePythonLock(text, name === "uv.lock");
}

function parsePackageLock(text: string) {
  const rows = text.split("\n");
  const state: PackageLockState = { current: null, packagesIndent: -1, end: rows.length, out: [] };
  for (const [i, row] of rows.entries()) parsePackageLockRow(state, row, i);
  flushPackageLock(state.out, state.current, state.end);
  return state.out.filter(registryRecord);
}

function parsePackageLockRow(state: PackageLockState, row: string, index: number) {
  const packages = /^(\s*)"packages":\s*\{/.exec(row);
  if (packages) return void (state.packagesIndent = packages[1].length);
  const entry = packageLockEntry(row, state.packagesIndent);
  if (entry !== null) return openPackageLockEntry(state, entry, index);
  const version = state.current && /^\s*"version":\s*"([^"]+)"/.exec(row);
  if (state.current && version) state.current.version = version[1];
  if (state.current && /^\s*"(?:resolved|integrity)":\s*"\S+"/.test(row)) state.current.registryBacked = true;
}

function openPackageLockEntry(state: PackageLockState, entry: string, index: number) {
  flushPackageLock(state.out, state.current, index);
  const module = entry.startsWith("node_modules/") ? entry.slice("node_modules/".length).split("/node_modules/").pop()! : "";
  state.current = module ? { name: module, version: "", line: index + 1, end: state.end, registry: "npm", registryBacked: false } : null;
}

function flushPackageLock(out: LockRecord[], current: PackageLockRecord | null, end: number) {
  if (current?.version && current.registryBacked) out.push({ name: current.name, version: current.version, line: current.line, end, registry: "npm" });
}

function packageLockEntry(row: string, packagesIndent: number) {
  if (packagesIndent < 0) return null;
  const hit = /^(\s*)"((?:[^"\\]|\\.)*)":\s*\{\s*$/.exec(row);
  if (!hit || hit[1].length !== packagesIndent + 2) return null;
  try {
    return JSON.parse(`"${hit[2]}"`) as string;
  } catch {
    return null;
  }
}

function parseBunLock(text: string) {
  const out: LockRecord[] = [];
  let packages = false;
  text.split("\n").forEach((row, i) => {
    if (/^\s*"packages":\s*\{/.test(row)) packages = true;
    else if (packages && /^\s{2}\},?\s*$/.test(row)) packages = false;
    if (!packages) return;
    const hit = /^\s{4}"[^"]+":\s*\[\s*"((?:[^"\\]|\\.)+)"/.exec(row);
    const spec = hit ? splitNpmSpec(JSON.parse(`"${hit[1]}"`)) : null;
    if (spec) out.push({ ...spec, line: i + 1, end: i + 1, registry: "npm" });
  });
  return out.filter(registryRecord);
}

function parsePnpmLock(text: string) {
  const out: LockRecord[] = [];
  let packages = false;
  text.split("\n").forEach((row, i) => {
    if (row === "packages:") packages = true;
    else if (packages && /^\S/.test(row)) packages = false;
    if (!packages) return;
    const hit = /^\s{2}['"]?(.+?)['"]?:\s*$/.exec(row);
    const spec = hit ? splitNpmSpec(hit[1].replace(/\(.+$/, "")) : null;
    if (spec) out.push({ ...spec, line: i + 1, end: i + 1, registry: "npm" });
  });
  return out.filter(registryRecord);
}

function parsePythonLock(text: string, requireRegistry: boolean) {
  const out: LockRecord[] = [];
  let start = 0;
  let name = "";
  let version = "";
  let registry = !requireRegistry;
  const rows = text.split("\n");
  const flush = (end: number) => {
    if (name && version && registry) out.push({ name, version, line: start, end, registry: "pypi" });
  };
  rows.forEach((row, i) => {
    if (row.trim() === "[[package]]") {
      flush(i);
      [start, name, version, registry] = [i + 1, "", "", !requireRegistry];
      return;
    }
    const n = /^name\s*=\s*"([^"]+)"/.exec(row);
    const v = /^version\s*=\s*"([^"]+)"/.exec(row);
    if (n) name = n[1];
    if (v) version = v[1];
    if (/^source\s*=.*\bregistry\s*=/.test(row)) registry = true;
    if (/^source\s*=.*\b(editable|path|git|url|virtual)\s*=/.test(row)) registry = false;
  });
  flush(rows.length);
  return out.filter(registryRecord);
}

function splitNpmSpec(value: string) {
  const clean = value.startsWith("/") ? value.slice(1) : value;
  const spec = clean.startsWith("npm:") ? clean.slice(4) : clean;
  const slash = spec.startsWith("@") ? spec.indexOf("/") : -1;
  const at = spec.lastIndexOf("@");
  if (at <= slash) return null;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const registryRecord = (record: LockRecord) => /^\d[0-9A-Za-z.!+_-]*$/.test(record.version) && !/^(file|git|workspace|link):/.test(record.version);

function readAgeCache(path: string): AgeCache {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.version === 1 && value.published && typeof value.published === "object") return value;
  } catch {
    return { version: 1, published: {} };
  }
  return { version: 1, published: {} };
}

function publishedAt(record: LockRecord, o: Opts, deps: SecurityDeps): Published {
  if (record.registry === "npm") return npmPublished(record, o, deps);
  const url = `https://pypi.org/pypi/${encodeURIComponent(record.name)}/${encodeURIComponent(record.version)}/json`;
  const result = deps.run("curl", ["-fsSL", "--max-time", "10", url], o.repo);
  if (result.code !== 0) return failedRegistry(result);
  try {
    const json = JSON.parse(result.out);
    const dates = (json.urls ?? []).map((item: { upload_time_iso_8601?: string }) => item.upload_time_iso_8601).filter(Boolean).sort();
    return dates[0] ? { date: dates[0] } : { error: "PyPI response has no upload time" };
  } catch (e) {
    return { error: `invalid PyPI JSON: ${(e as Error).message}` };
  }
}

function npmPublished(record: LockRecord, o: Opts, deps: SecurityDeps): Published {
  const result = deps.run("npm", ["view", `${record.name}@${record.version}`, "time", "--json"], o.repo);
  if (result.code !== 0) return failedRegistry(result);
  try {
    const value = JSON.parse(result.out);
    const date = typeof value === "string" ? value : value[record.version];
    return typeof date === "string" ? { date } : { error: "npm response has no version publication time" };
  } catch (e) {
    return { error: `invalid npm JSON: ${(e as Error).message}` };
  }
}

const failedRegistry = (result: CmdResult): Published => (OFFLINE.test(`${result.err} ${result.out}`) ? { offline: true } : { error: commandError(result) });

function ageFinding(o: Opts, record: LockRecord, published: string, now: number): Finding | null {
  const stamp = Date.parse(published);
  if (!Number.isFinite(stamp)) return { rule: "deps/lock-age", file: record.file ?? ".", line: 0, msg: `${record.name}@${record.version}: invalid publication date ${published}` };
  const hours = Math.max(0, Math.floor((now - stamp) / 3_600_000));
  if (now - stamp >= o.toml.thresholds.min_release_age_days * 86_400_000) return null;
  return { rule: "deps/lock-age", file: record.file ?? ".", line: record.line, msg: `${record.name}@${record.version} published ${hours} hours ago; Bun minimumReleaseAge does not apply to locked versions (oven-sh/bun#30525)` };
}

// ---- new direct dependencies

type DirectDeps = Map<string, string>;

export function newPackageCheck(o: Opts, ch: Changes): Check {
  const notices: string[] = [];
  for (const file of [...ch.keys()].filter((name) => MANIFEST.test(name) && existsSync(join(o.repo, name)))) {
    const current = directDependencies(file, readFileSync(join(o.repo, file), "utf8"));
    const before = directDependencies(file, previousFile(o, file));
    for (const [name, range] of current) if (!before.has(name)) notices.push(`note: deps/new-package ${name}@${range}; expect qg:dep ${name} <why> in the report`);
  }
  return notedCheck("deps/new-package", [], "", [...new Set(notices)].sort());
}

function previousFile(o: Opts, file: string) {
  const ref = previousRef(o);
  if (!ref) return "";
  const result = run("git", ["show", `${ref}:${file}`], o.repo);
  return result.code === 0 ? result.out : "";
}

function previousRef(o: Opts) {
  if (o.scope.kind === "all") return "";
  if (o.scope.kind === "since") return o.scope.rev;
  if (o.scope.kind === "staged") return run("git", ["rev-parse", "-q", "--verify", "HEAD"], o.repo).out.trim();
  return run("git", ["merge-base", o.base, "HEAD"], o.repo).out.trim();
}

function directDependencies(file: string, text: string): DirectDeps {
  if (!text.trim()) return new Map();
  try {
    return file.endsWith("package.json") ? packageDependencies(JSON.parse(text)) : pythonDependencies(Bun.TOML.parse(text));
  } catch {
    return new Map();
  }
}

function packageDependencies(value: Record<string, unknown>) {
  const out: DirectDeps = new Map();
  addTable(out, value.dependencies);
  addTable(out, value.devDependencies);
  return out;
}

function pythonDependencies(value: Record<string, any>) {
  const out: DirectDeps = new Map();
  addPepList(out, nested(value, "project", "dependencies"));
  addPepList(out, nested(value, "project", "optional-dependencies", "dev"));
  addPepList(out, nested(value, "dependency-groups", "dev"));
  addPepList(out, nested(value, "tool", "uv", "dev-dependencies"));
  addTable(out, nested(value, "tool", "poetry", "dependencies"), new Set(["python"]));
  addTable(out, nested(value, "tool", "poetry", "group", "dev", "dependencies"));
  return out;
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function addTable(out: DirectDeps, value: unknown, skip = new Set<string>()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [name, spec] of Object.entries(value)) {
    if (skip.has(name)) continue;
    out.set(name, dependencyRange(spec));
  }
}

function dependencyRange(spec: unknown) {
  if (typeof spec === "string") return spec || "*";
  if (spec && typeof spec === "object" && "version" in spec) return String((spec as { version: unknown }).version);
  return JSON.stringify(spec) || "*";
}

function addPepList(out: DirectDeps, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const hit = /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/.exec(String(item));
    if (hit) out.set(hit[1], hit[2] || "*");
  }
}

// ---- cached dependency audit

type AuditVulnerability = { package: string; id: string; severity: "high" | "critical" };
type AuditCache = { version: 1; lock: string; sha256: string; tool: string; vulnerabilities: AuditVulnerability[] };
type AuditTarget = { lock: string; cmd: string; args: string[]; tool: string };
type FreshAudit = { target: AuditTarget; sha256: string; cachePath: string; deps: SecurityDeps };

export function auditCheck(o: Opts, deps: SecurityDeps = REAL): Check {
  if (!o.toml.security.audit) return check("deps/audit", [], "", "disabled by [security]");
  const target = auditTarget(o, deps);
  if ("notice" in target) return notedCheck("deps/audit", [], "", [target.notice]);
  const sha256 = hashFile(join(o.repo, target.lock));
  const cachePath = join(o.out, "audit.json");
  const cached = readAuditCache(cachePath);
  if (cached?.sha256 === sha256 && cached.tool === target.tool) return auditResult(target.lock, cached.vulnerabilities, "cached");
  return freshAudit(o, { target, sha256, cachePath, deps });
}

function freshAudit(o: Opts, context: FreshAudit) {
  const { target, sha256, cachePath, deps } = context;
  const result = deps.run(target.cmd, target.args, o.repo);
  if (auditOffline(result)) return notedCheck("deps/audit", [], "", ["deps/audit: not checked (offline)"]);
  const parsed = parseJsonOutput(result.out);
  if (!parsed) return check("deps/audit", [], `${target.tool}: audit output unreadable${commandError(result) ? `: ${commandError(result)}` : ""}`);
  const toolError = auditError(parsed);
  if (result.code !== 0 && toolError) return check("deps/audit", [], `${target.tool}: ${toolError}`);
  const vulnerabilities = auditVulnerabilities(parsed);
  writeJson(cachePath, { version: 1, lock: target.lock, sha256, tool: target.tool, vulnerabilities } satisfies AuditCache);
  return auditResult(target.lock, vulnerabilities, "fresh");
}

function auditOffline(result: CmdResult) {
  return result.code === -1 || (result.code !== 0 && (!result.out.trim() || AUDIT_OFFLINE.test(result.err)));
}

function auditTarget(o: Opts, deps: SecurityDeps): AuditTarget | { notice: string } {
  if (existsSync(join(o.repo, "bun.lock"))) {
    const help = deps.run("bun", ["audit", "--help"], o.repo);
    if (help.code === 0) return { lock: "bun.lock", cmd: "bun", args: ["audit", "--json"], tool: "bun audit --json" };
  }
  if (existsSync(join(o.repo, "package-lock.json"))) return { lock: "package-lock.json", cmd: "npm", args: ["audit", "--json", "--omit=dev"], tool: "npm audit --json --omit=dev" };
  const py = ["uv.lock", "poetry.lock"].find((file) => existsSync(join(o.repo, file)));
  if (py) return { lock: py, cmd: "uvx", args: ["pip-audit", "-f", "json", "--locked", "."], tool: "uvx pip-audit -f json --locked ." };
  return { notice: "deps/audit: not checked (no supported lockfile or audit command)" };
}

function readAuditCache(path: string): AuditCache | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value.version === 1 && Array.isArray(value.vulnerabilities) ? value : null;
  } catch {
    return null;
  }
}

function parseJsonOutput(text: string): unknown | null {
  const whole = tryJson(text);
  if (whole !== null) return whole;
  try {
    const rows = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

function tryJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function auditError(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const error = (value as Record<string, unknown>).error;
  if (!error) return "";
  if (typeof error === "string") return redactSensitiveText(error);
  return redactSensitiveText(JSON.stringify(error)).slice(0, 300);
}

function auditVulnerabilities(value: unknown) {
  const out = new Map<string, AuditVulnerability>();
  collectVulnerabilities(value, out, "");
  addAuditSummary(value, out);
  return [...out.values()];
}

function collectVulnerabilities(value: unknown, out: Map<string, AuditVulnerability>, context: string) {
  if (Array.isArray(value)) return value.forEach((item) => collectVulnerabilities(item, out, context));
  const item = recordOf(value);
  if (!item) return;
  const severity = String(item.severity ?? "").toLowerCase();
  if (highSeverity(severity) && !hasDetailedVia(item)) addAuditVulnerability(out, item, context, severity);
  for (const [key, child] of Object.entries(item)) collectVulnerabilities(child, out, key === "vulnerabilities" ? "" : context || key);
}

const recordOf = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const highSeverity = (value: string): value is "high" | "critical" => value === "high" || value === "critical";
const hasDetailedVia = (item: Record<string, unknown>) => Array.isArray(item.via) && item.via.some((entry) => entry && typeof entry === "object");

function addAuditVulnerability(out: Map<string, AuditVulnerability>, item: Record<string, unknown>, context: string, severity: "high" | "critical") {
  const pkg = String((item.name ?? item.module_name ?? item.package ?? item.dependency ?? context) || "unknown");
  const id = String(item.id ?? item.source ?? item.cve ?? item.title ?? "advisory");
  out.set(`${pkg}:${id}:${severity}`, { package: pkg, id, severity });
}

function addAuditSummary(value: unknown, out: Map<string, AuditVulnerability>) {
  if (out.size || !value || typeof value !== "object" || Array.isArray(value)) return;
  const counts = (value as any).metadata?.vulnerabilities;
  for (const severity of ["critical", "high"] as const) {
    const count = Number(counts?.[severity] ?? 0);
    if (count > 0) out.set(`summary:${severity}`, { package: `${count} package(s)`, id: "audit summary", severity });
  }
}

function auditResult(lock: string, vulnerabilities: AuditVulnerability[], note: string) {
  const findings = vulnerabilities.map((v): Finding => ({ rule: "deps/audit", file: lock, line: 0, msg: `${v.package}: ${v.id} (${v.severity})` }));
  return check("deps/audit", findings, "", note);
}

const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
}

export const securityChangeChecks = (o: Opts, ch: Changes, deps: SecurityDeps = REAL) => [lockAgeCheck(o, ch, deps), newPackageCheck(o, ch)];
