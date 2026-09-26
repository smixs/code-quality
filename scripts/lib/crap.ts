// CRAP per function (A-exact-2): tests + lcov, function ranges from the eslint AST / lizard.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Opts } from "./config.ts";
import { type Changes, WHOLE } from "./diff.ts";
import { adapterForFile, defaultTestCommand, rootForFile, type LanguageRoot } from "./lang.ts";
import { npmSpec, packageSpec, pinnedVersion, toolsDir } from "./tools.ts";
import { git, gitPaths, lines, refuse, run, withoutRepoVars } from "./util.ts";

export type Range = { start: number; end: number; col: number; nested: [number, number][] };
export type Fn = Range & { file: string; name: string; key: string; cc: number; cov: number | null; crap: number | null };
export type Coverage = "run" | "reuse" | "fresh-or-none";
export type Tests = { lcov: string; code: number; failed: number | null; skipped: boolean; red: boolean; used: boolean; lastRun?: { written: string; commit: string } };

export const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const TS_SKIP = /(\.d\.ts$|\.(test|spec)\.|(^|\/)(fixtures|__tests__|node_modules|dist|build|\.scratch)\/)/;
const PY_SKIP = /((^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$|(^|\/)(\.venv|\.scratch)\/)/;
const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const SKIP_KEYS = new Set(["parent", "loc", "range", "tokens", "comments"]);
const LABEL = /^(.*?) has a complexity of (\d+)\./;
const FAIL_COUNTS = [/^\s*(\d+) fail\b/gm, /^\s*(\d+) failed\b/gm, /^ℹ fail (\d+)\b/gm, /^# fail (\d+)\b/gm, /^Tests\s+(\d+) failed\b/gm, /(\d+) failed\b/g];
// Fallback toolchain when the repo has no eslint; pinned in tools.ts like every other tool.
const fallbackPkgs = (o: Opts) => ["eslint", "typescript-eslint-parser", "typescript"].map((id) => npmSpec(id, o.toml.tools));

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const defaultTestCmd = (o: Opts, lang = o.lang) => defaultTestCommand(o.repo, lang, readText);

function configuredTestCmd(o: Opts) {
  if (o.testCmd) return o.testCmd;
  if (o.lang === "ts" || o.lang === "py") return defaultTestCmd(o);
  return o.langs[0]?.adapter.coverage.command ?? defaultTestCmd(o, "ts");
}

const metaPath = (o: Opts) => join(o.out, "lcov.meta.json");
const lcovPath = (o: Opts) => join(o.out, "lcov.info");
const NO_TESTS: Tests = { lcov: "", code: 0, failed: null, skipped: true, red: false, used: false };

export function runTests(o: Opts, mode: Coverage): Tests {
  if (mode === "reuse") return reuseLcov(o);
  if (mode === "fresh-or-none") return freshLcovOrLastRun(o);
  return runFresh(o);
}

function freshLcovOrLastRun(o: Opts) {
  const meta = readMeta(o);
  if (meta && existsSync(lcovPath(o)) && lcovFresh(o, meta)) return testsFrom(lcovPath(o), meta, true);
  return meta ? { ...NO_TESTS, lastRun: lastRun(meta) } : NO_TESTS;
}

function runFresh(o: Opts): Tests {
  rmSync(lcovPath(o), { force: true });
  const commit = git(o.repo, "rev-parse", "HEAD").trim();
  const fingerprint = sourceFingerprint(o, commit);
  const env = withoutRepoVars({ ...process.env, QG_LCOV: lcovPath(o), QG_DIR: o.out });
  const r = spawnSync("sh", ["-c", `${configuredTestCmd(o)} > "$QG_DIR/tests.log" 2>&1`], { cwd: o.repo, env, stdio: "inherit" });
  if (!existsSync(lcovPath(o))) throw new Error(`no coverage at ${lcovPath(o)}; see ${o.out}/tests.log`);
  const meta = { commit, fingerprint, code: r.status ?? -1, failed: countFailed(readFileSync(join(o.out, "tests.log"), "utf8")), written: new Date().toISOString() };
  writeFileSync(metaPath(o), JSON.stringify(meta, null, 1));
  return testsFrom(lcovPath(o), meta, false);
}

type TestMeta = { commit: string; fingerprint: string; code: number; failed: number | null; written?: string };

const lastRun = (m: TestMeta) => ({ written: m.written ?? "unknown date", commit: m.commit });

const testsFrom = (lcov: string, m: TestMeta, skipped: boolean): Tests => ({
  lcov,
  code: m.code,
  failed: m.failed,
  skipped,
  red: m.code !== 0 || (m.failed ?? 0) > 0,
  used: true,
  lastRun: lastRun(m),
});

function countFailed(log: string) {
  for (const re of FAIL_COUNTS) {
    const counts = [...log.matchAll(re)].map((m) => Number(m[1]));
    if (counts.length) return counts.reduce((sum, n) => sum + n, 0);
  }
  return null;
}

function readMeta(o: Opts): TestMeta | null {
  if (!existsSync(metaPath(o))) return null;
  return JSON.parse(readFileSync(metaPath(o), "utf8")) as TestMeta;
}

function lcovFresh(o: Opts, meta: TestMeta) {
  return sourceFingerprint(o, meta.commit) === meta.fingerprint;
}

// --skip-tests is only honest when nothing under --src changed since the lcov was written.
function reuseLcov(o: Opts): Tests {
  const meta = readMeta(o);
  if (!meta || !existsSync(lcovPath(o))) refuse(`--skip-tests refused: no ${lcovPath(o)} with lcov.meta.json next to it; run without --skip-tests`);
  if (lcovFresh(o, meta)) return testsFrom(lcovPath(o), meta, true);
  const files = changedSince(o, meta.commit);
  refuse(`--skip-tests refused: files under --src changed since the lcov was written at ${meta.commit.slice(0, 8)}:\n${files.slice(0, 20).join("\n")}\nrun without --skip-tests`);
}

// Diff against the commit plus contents of untracked files: covers commits, edits and new files.
function sourceFingerprint(o: Opts, commit: string) {
  const h = createHash("sha1").update(gitPaths(o.repo, "diff", commit, "--", ...o.dirs));
  for (const f of untracked(o)) h.update(f).update(readFileSync(join(o.repo, f)));
  return h.digest("hex");
}

const untracked = (o: Opts) => lines(gitPaths(o.repo, "ls-files", "--others", "--exclude-standard", "--", ...o.dirs)).filter((f) => !f.startsWith(".scratch/"));

function changedSince(o: Opts, commit: string) {
  const tracked = lines(gitPaths(o.repo, "diff", "--name-only", commit, "--", ...o.dirs));
  const all = [...tracked, ...untracked(o).map((f) => `${f} (untracked)`)];
  return all.length ? all : ["(untracked files changed)"];
}

// lcov: DA hits of duplicate SF records are added together.
export function parseLcov(path: string, repo: string) {
  const da = new Map<string, Map<number, number>>();
  let cur = new Map<number, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) cur = lcovFile(da, relative(repo, resolve(repo, line.slice(3).trim())));
    else if (line.startsWith("DA:")) addHits(cur, line.slice(3));
  }
  return da;
}

function lcovFile(da: Map<string, Map<number, number>>, rel: string) {
  if (!da.has(rel)) da.set(rel, new Map());
  return da.get(rel)!;
}

function addHits(m: Map<number, number>, rest: string) {
  const [ln, hits] = rest.split(",").map(Number);
  m.set(ln, (m.get(ln) ?? 0) + hits);
}

export function sourceFiles(o: Opts) {
  const all = gitPaths(o.repo, "ls-files", "--cached", "--others", "--exclude-standard", "--", ...o.dirs);
  return lines(all).filter((file) => {
    const adapter = adapterForFile(o.langs, file);
    const skip = adapter?.id === "py" ? PY_SKIP : adapter?.id === "ts" ? TS_SKIP : /(^|\/)(fixtures|tests?|node_modules|dist|build|target|\.scratch)\//;
    return adapter && !skip.test(file) && existsSync(join(o.repo, file));
  });
}

export function loadEslint(o: Opts) {
  const fromRepo = tryRequire(join(o.repo, "package.json"));
  if (fromRepo) return fromRepo;
  const dir = toolsDir(o.toml.project.tools_dir);
  ensureTools(fallbackPkgs(o), dir);
  const fromTools = tryRequire(join(dir, "package.json"));
  if (!fromTools) throw new Error(`cannot load eslint + @typescript-eslint/parser from ${o.repo} or ${dir}`);
  return fromTools;
}

// Install pinned packages into the tool cache once; never into the repo.
// Every package is probed: one present as another's dependency (eslint under sonarjs) says nothing of the rest.
export function ensureTools(pkgs: string[], dir: string) {
  mkdirSync(dir, { recursive: true });
  if (pkgs.every((p) => existsSync(join(dir, "node_modules", p.slice(0, p.lastIndexOf("@")), "package.json")))) return;
  const r = run("npm", ["i", "--save-exact", "--prefix", dir, ...pkgs], dir, { timeout: 600_000 });
  if (r.code !== 0) throw new Error(`npm i ${pkgs.join(" ")} into ${dir} failed: ${r.err.slice(0, 300)}`);
}

function tryRequire(anchor: string) {
  try {
    const req = createRequire(anchor);
    return { Linter: req("eslint").Linter, parser: req("@typescript-eslint/parser") };
  } catch {
    return null;
  }
}

export function walk(node: any, parent: Range | null, out: Range[]) {
  let cur = parent;
  if (FN_TYPES.has(node.type)) {
    cur = { start: node.loc.start.line, end: node.loc.end.line, col: node.loc.start.column, nested: [] };
    out.push(cur);
    parent?.nested.push([cur.start, cur.end]);
  }
  for (const child of children(node)) walk(child, cur, out);
}

function children(node: any): any[] {
  return Object.entries(node)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .flatMap(([, v]) => [v].flat())
    .filter(isNode);
}

const isNode = (c: any) => c !== null && typeof c === "object" && typeof c.type === "string";

export const TS_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

type NativeFunctions = { fns: Fn[]; fallback: string[] };
type AnalysisDeps = { run: typeof run; loadEslint: typeof loadEslint };

function tsFunctions(o: Opts, files: string[], deps: AnalysisDeps): NativeFunctions {
  let loaded: ReturnType<typeof loadEslint>;
  try {
    loaded = deps.loadEslint(o);
  } catch {
    return { fns: [], fallback: files };
  }
  const linter = new loaded.Linter({ configType: "flat", cwd: o.repo });
  const config = [{ files: [TS_GLOB], linterOptions: { noInlineConfig: true }, languageOptions: { parser: loaded.parser }, rules: { complexity: ["warn", 0] } }];
  const results = files.map((file) => lintFile({ repo: o.repo, linter, config }, file));
  return {
    fns: results.flatMap((result) => result.fns),
    fallback: results.filter((result) => !result.ok).map((result) => result.file),
  };
}

function lintFile(ctx: { repo: string; linter: any; config: object[] }, file: string) {
  const path = join(ctx.repo, file);
  const msgs = ctx.linter.verify(readFileSync(path, "utf8"), ctx.config, { filename: path });
  const ast = ctx.linter.getSourceCode()?.ast;
  if (!ast || msgs.some((m: any) => m.fatal)) return { file, fns: [] as Fn[], ok: false };
  const fns = matchMessages(file, msgs, ast);
  return { file, fns, ok: true };
}

// eslint reports each function at its head line; the AST gives its exact range.
function matchMessages(file: string, msgs: any[], ast: any) {
  const ranges: Range[] = [];
  walk(ast, null, ranges);
  const byLine = Map.groupBy(ranges.sort((a, b) => a.col - b.col), (r) => r.start);
  const fns: Fn[] = [];
  for (const m of msgs.filter((x) => x.ruleId === "complexity").sort((a, b) => a.column - b.column)) {
    const r = byLine.get(m.line)?.shift();
    const hit = LABEL.exec(m.message);
    if (r && hit) fns.push({ ...r, file, name: hit[1], key: "", cc: Number(hit[2]), cov: null, crap: null });
  }
  return fns;
}

function csvColumns(line: string) {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      out.push(field);
      field = "";
    } else field += char;
  }
  out.push(field);
  return out;
}

export function parseLizardCsv(out: string): Fn[] {
  return out.split("\n").filter(Boolean).flatMap((line) => lizardRow(csvColumns(line)));
}

function lizardRow(row: string[]): Fn[] {
  if (row.length < 11 || !Number.isFinite(Number(row[1]))) return [];
  return [{ file: row[6], name: row[7], key: "", cc: Number(row[1]), start: Number(row[9]), end: Number(row[10]), col: 0, nested: [], cov: null, crap: null }];
}

function repoFile(repo: string, file: string) {
  const clean = normalize(file);
  return isAbsolute(clean) ? relative(repo, clean) : clean.replace(/^\.\//, "");
}

function nestedRanges(fns: Fn[]) {
  for (const f of fns) f.nested = fns.filter((g) => g !== f && g.file === f.file && g.start > f.start && g.end <= f.end).map((g) => [g.start, g.end]);
}

function runLizard(o: Opts, root: LanguageRoot, files: string[], runner = run) {
  if (!root.adapter.lizardLang) return { fns: [] as Fn[], failed: [`not run: crap/cc (Lizard does not support ${root.adapter.name}; ${root.adapter.form.install})`] };
  const spec = packageSpec("lizard", o.toml.tools);
  const args = ["tool", "run", "--from", spec, "lizard", "--csv", "-l", root.adapter.lizardLang, ...files];
  const result = runner("uv", args, o.repo, { timeout: 300_000 });
  if (result.code !== 0) return { fns: [] as Fn[], failed: [`not run: crap/cc (lizard ${pinnedVersion(spec, "==")} failed for ${root.adapter.name}: ${(result.err || result.out).trim().slice(0, 160)}; install uv)`] };
  const fns = parseLizardCsv(result.out).map((fn) => ({ ...fn, file: repoFile(o.repo, fn.file) }));
  nestedRanges(fns);
  return { fns, failed: [] as string[] };
}

type RadonBlock = {
  type?: string;
  name?: string;
  lineno?: number;
  endline?: number;
  col_offset?: number;
  complexity?: number;
  closures?: RadonBlock[];
  methods?: RadonBlock[];
};

function radonBlocks(file: string, blocks: RadonBlock[], out: Fn[]) {
  for (const block of blocks) {
    if (block.type !== "class" && block.name && Number.isFinite(block.lineno) && Number.isFinite(block.endline) && Number.isFinite(block.complexity)) {
      out.push({
        file,
        name: block.name,
        key: "",
        cc: block.complexity!,
        start: block.lineno!,
        end: block.endline!,
        col: block.col_offset ?? 0,
        nested: [],
        cov: null,
        crap: null,
      });
    }
    radonBlocks(file, block.methods ?? [], out);
    radonBlocks(file, block.closures ?? [], out);
  }
}

function radonResult(out: string, repo: string) {
  const value = JSON.parse(out) as Record<string, RadonBlock[] | { error?: string }>;
  const fns: Fn[] = [];
  const parsed = new Set<string>();
  for (const [rawFile, blocks] of Object.entries(value)) {
    const file = repoFile(repo, rawFile);
    if (!Array.isArray(blocks)) continue;
    parsed.add(file);
    radonBlocks(file, blocks, fns);
  }
  nestedRanges(fns);
  return { fns, parsed };
}

export function parseRadonJson(out: string, repo: string) {
  return radonResult(out, repo).fns;
}

function pyFunctions(o: Opts, files: string[], deps: AnalysisDeps): NativeFunctions {
  if (!files.length) return { fns: [], fallback: [] };
  const result = deps.run("uvx", ["--from", packageSpec("radon", o.toml.tools), "radon", "cc", "-j", ...files], o.repo, { timeout: 300_000 });
  if (result.code !== 0) return { fns: [], fallback: files };
  try {
    const parsed = radonResult(result.out, o.repo);
    return { fns: parsed.fns, fallback: files.filter((file) => !parsed.parsed.has(file)) };
  } catch {
    return { fns: [], fallback: files };
  }
}

function nativeFunctions(o: Opts, root: LanguageRoot, files: string[], deps: AnalysisDeps): NativeFunctions | null {
  if (root.adapter.id === "ts") return tsFunctions(o, files, deps);
  if (root.adapter.id === "py") return pyFunctions(o, files, deps);
  return null;
}

function withLizardFallback(o: Opts, root: LanguageRoot, native: NativeFunctions, deps: AnalysisDeps) {
  const fns = [...native.fns];
  const failed: string[] = [];
  for (const file of native.fallback) {
    const fallback = runLizard(o, root, [file], deps.run);
    fns.push(...fallback.fns);
    if (fallback.failed.length) failed.push(file, ...fallback.failed);
    else failed.push(`crap: lizard fallback for ${file}`);
  }
  return { fns, failed };
}

export function functionsOf(o: Opts, files: string[], deps: AnalysisDeps = { run, loadEslint }) {
  const grouped = Map.groupBy(files, (file) => rootForFile(o.langs, file));
  const fns: Fn[] = [];
  const failed: string[] = [];
  for (const [root, languageFiles] of grouped) {
    if (!root) continue;
    const native = nativeFunctions(o, root, languageFiles, deps);
    const result = native ? withLizardFallback(o, root, native, deps) : runLizard(o, root, languageFiles, deps.run);
    fns.push(...result.fns);
    failed.push(...result.failed);
  }
  return { fns, failed };
}

// Own lines: nested bodies out, signature line out unless the function is one line.
export function ownLines(f: Range) {
  const from = f.end > f.start ? f.start + 1 : f.start;
  const all = Array.from({ length: f.end - from + 1 }, (_, i) => from + i);
  return all.filter((l) => !f.nested.some(([a, b]) => l >= a && l <= b));
}

export function score(fns: Fn[], t: Tests, repo: string) {
  const da = t.used ? parseLcov(t.lcov, repo) : new Map<string, Map<number, number>>();
  const seen = new Map<string, number>();
  for (const f of fns) {
    const base = `${f.file}::${f.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    f.key = n ? `${base}#${n}` : base;
    setCrap(f, da.get(f.file));
  }
}

function setCrap(f: Fn, hits: Map<number, number> | undefined) {
  const own = ownLines(f).filter((l) => hits?.has(l));
  if (!own.length) return;
  f.cov = own.filter((l) => hits!.get(l)! > 0).length / own.length;
  f.crap = f.cc ** 2 * (1 - f.cov) ** 3 + f.cc;
}

// One rule everywhere (summary, worklist, top, hotspots, gate): no coverage data = 0% coverage.
export const riskCrap = (f: Fn) => f.crap ?? f.cc ** 2 + f.cc;

export function isChanged(f: Range & { file: string }, ch: Changes) {
  const d = ch.get(f.file);
  if (!d) return false;
  return d.touched.has(WHOLE) || [f.start, ...ownLines(f)].some((l) => d.touched.has(l));
}
