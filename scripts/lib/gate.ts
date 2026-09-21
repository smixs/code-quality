// The gate: CRAP bar on changed functions, repo mean CRAP, deps/knip ratchet, deterministic checks.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { adapterChecks, adapterFindingKeys, type AdapterToolCheck, type AdapterToolKind, ratchetAdapterChecks } from "./adapter-tools.ts";
import { astCheck, semgrepCheck } from "./astgrep.ts";
import type { Opts } from "./config.ts";
import { type Coverage, type Fn, functionsOf, isChanged, riskCrap, runTests, score, sourceFiles, type Tests } from "./crap.ts";
import { type Changes, changes } from "./diff.ts";
import { diffCoverageCheck } from "./diffcov.ts";
import { depcruise, type Deps, knip, type Knip } from "./deps.ts";
import { dupCheck } from "./dup.ts";
import { formCheck } from "./form.ts";
import { tamperCheck } from "./tamper.ts";
import { docCheck, glossaryCheck, secretCheck } from "./text.ts";
import { gitleaksCheck, securityChangeChecks } from "./security.ts";
import { type Check, check, type Finding, git, globMatch, notedCheck, run } from "./util.ts";

type BaseFn = { line: number; cc: number; crap: number | null };
type BaseDeps = { cycles: string[]; layers: string[] };
type Baseline = { head: string; functions: Record<string, BaseFn>; deps?: BaseDeps | null; mean?: number; knip?: string[]; tools?: string[] };
type Debt = { deps: Deps | null; knip: Knip | null; tools: AdapterToolCheck[] };

export type Analysis = ReturnType<typeof analyze>;

export function analyze(o: Opts, mode: Coverage) {
  mkdirSync(o.out, { recursive: true });
  const ch = changes(o);
  const tests = runTests(o, mode);
  const docsOnly = isDocsOnly(o, ch);
  if (docsOnly) return { ch, tests, fns: [], failed: [], checks: docsOnlyChecks(o, ch), deps: null, knip: null, adapterTools: [] as AdapterToolCheck[], adapterAudit: false, docsOnly };
  const all = sourceFiles(o);
  // Without coverage the mean is unknown, so only changed files need a parse.
  const files = tests.used ? all : all.filter((f) => ch.has(f));
  const functions = functionsOf(o, files);
  const failed = functions.failed.filter((line) => !line.startsWith("not run:") && !line.startsWith("crap:"));
  const toolNotices = functions.failed.filter((line) => line.startsWith("not run:") || line.startsWith("crap:"));
  const fns = functions.fns;
  score(fns, tests, o.repo);
  const noDeps = o.flags["no-deps"] || !o.langs.some((item) => item.adapter.id === "ts");
  const adapterAudit = mode !== "fresh-or-none";
  const adapterTools = projectAdapterChecks(o, adapterAudit);
  const checks = [
    notedCheck("crap/tools", [], "", toolNotices),
    tamperCheck(o, ch),
    diffCoverageCheck(o, ch, tests, { lowCoverage: mode !== "fresh-or-none", missingFiles: mode !== "fresh-or-none" }),
    formCheck(o, ch, all),
    dupCheck(o, ch, all),
    astCheck(o, ch),
    semgrepCheck(o, ch),
    docCheck(o, ch),
    glossaryCheck(o, ch),
    secretCheck(o, ch),
    ...securityChangeChecks(o, ch),
    ...(mode === "fresh-or-none" ? [] : [gitleaksCheck(o)]),
  ];
  return { ch, tests, fns, failed, checks, deps: noDeps ? null : depcruise(o), knip: noDeps ? null : knip(o), adapterTools, adapterAudit, docsOnly };
}

function projectAdapterChecks(o: Opts, includeAudit: boolean) {
  const roots = o.langs.filter((item) => item.adapter.id !== "ts");
  const structural: AdapterToolKind[] = o.flags["no-deps"] ? ["form"] : ["cycles", "dead", "form"];
  const checks = roots.length ? adapterChecks(o, structural, { roots }) : [];
  return includeAudit ? [...checks, ...adapterChecks(o, ["audit"])] : checks;
}

const DOC_ONLY = /\.(?:md|toml|json|ya?ml)$/i;

function isDocsOnly(o: Opts, ch: Changes) {
  return o.scope.kind !== "all" && ch.size > 0 && [...ch.keys()].every((file) => DOC_ONLY.test(file) && !inProjectDirs(o.dirs, file));
}

function inProjectDirs(dirs: string[], file: string) {
  return dirs.some((raw) => {
    const dir = normalize(raw).replace(/^\.\/$/, ".").replace(/\/$/, "");
    return dir === "." || file === dir || file.startsWith(`${dir}/`);
  });
}

function docsOnlyChecks(o: Opts, ch: Changes) {
  return [tamperCheck(o, ch), docCheck(o, ch), glossaryCheck(o, ch), secretCheck(o, ch)];
}

// --all measures the whole tree: the baseline is ignored so old debt shows as findings.
function baselineState(o: Opts): { value: Baseline | null; missing: boolean } {
  if (o.scope.kind === "all") return { value: null, missing: false };
  if (!existsSync(o.baseline)) return { value: null, missing: true };
  return { value: JSON.parse(readFileSync(o.baseline, "utf8")), missing: false };
}

function fnReasons(o: Opts, f: Fn, t: Tests) {
  return [complexityReason(o, f), crapReason(o, f, t)].filter(Boolean);
}

const complexityReason = (o: Opts, f: Fn) => f.cc > o.maxCc ? `complexity ${f.cc} > ${o.maxCc} (split)` : "";

function crapReason(o: Opts, f: Fn, t: Tests) {
  if (!t.used || riskCrap(f) <= o.maxCrap) return "";
  const coverage = f.cov === null ? "no coverage data" : `cov ${Math.round(f.cov * 100)}%`;
  return `CRAP ${riskCrap(f).toFixed(1)} > ${o.maxCrap} (${coverage}; tests or split)`;
}

const worse = (f: Fn, b: BaseFn) => f.cc > b.cc || (f.crap ?? 0) > (b.crap ?? Infinity) + 0.01;

function driftReason(f: Fn, b: BaseFn | undefined) {
  if (!b || !worse(f, b)) return null;
  return `worse: CRAP ${fmt(b.crap)} -> ${fmt(f.crap)}, cc ${b.cc} -> ${f.cc}`;
}

const fmt = (n: number | null) => (n === null ? "n/a" : n.toFixed(1));

// Gate only on changed functions against the one bar. Unchanged functions that got worse are
// coverage drift from flaky tests: reported, never gated.
function gateFunctions(o: Opts, a: Analysis, base: Baseline | null) {
  const fails: Finding[] = [];
  const drift: string[] = [];
  for (const f of a.fns) {
    if (isChanged(f, a.ch)) fails.push(...fnReasons(o, f, a.tests).map((msg) => ({ rule: "crap", file: f.file, line: f.start, msg: `${f.name}: ${msg}` })));
    else pushDrift(drift, f, base?.functions[f.key]);
  }
  return { fails, drift };
}

function pushDrift(drift: string[], f: Fn, b: BaseFn | undefined) {
  const r = driftReason(f, b);
  if (r) drift.push(`${f.key}:${f.start}  ${r}`);
}

export function meanCrap(fns: Fn[]) {
  return fns.reduce((s, f) => s + riskCrap(f), 0) / (fns.length || 1);
}

// Mean CRAP is diagnostic: warn only when it is over the bar and grew beyond the noise tolerance.
function meanDrift(o: Opts, a: Analysis, base: Baseline | null): string[] {
  const before = base?.mean;
  if (!a.tests.used || before === undefined) return [];
  const mean = meanCrap(a.fns);
  const t = o.toml.thresholds;
  if (mean <= t.max_mean_crap || mean <= before + t.mean_tolerance) return [];
  const delta = mean - before;
  return [`note: crap/mean: ${mean.toFixed(2)} (baseline ${before.toFixed(2)}, ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`];
}

// New cycles and layer violations fail; the ones in the baseline are old debt.
function depFails(deps: Deps | null, base: Baseline | null): Finding[] {
  if (!deps) return [];
  if (deps.error) return [depFinding(`deps: ${deps.error}`)];
  const known = base ? base.deps : { cycles: [], layers: [] };
  if (!known) return [depFinding("deps: baseline has no dependency lists, rerun with --update-baseline")];
  const cycles = deps.cycles.filter((c) => !known.cycles.includes(c.key)).map((c) => `new import cycle: ${c.text}`);
  return [...cycles, ...deps.layers.filter((l) => !known.layers.includes(l)).map((l) => `new layer violation: ${l}`)].map(depFinding);
}

const depFinding = (msg: string): Finding => ({ rule: "deps", file: ".", line: 0, msg });

const knipItems = (k: Knip) => [...k.files.map((f) => `file ${f}`), ...k.exports.map((e) => `export ${e}`)];

// Dead code ratchet: only items missing from the baseline list fail; no list = report only.
function knipCheck(k: Knip | null, base: Baseline | null, includeFiles = true): Check {
  if (!k) return check("knip", []);
  if (k.error) return check("knip", [], k.error);
  const known = knownKnip(base);
  if (!known) return check("knip", [], "", "baseline has no knip list; --update-baseline to gate dead code");
  return check("knip", newKnip(k, known, includeFiles));
}

const knownKnip = (base: Baseline | null) => (base ? (base.knip ?? null) : []);

function newKnip(k: Knip, knownList: string[], includeFiles: boolean): Finding[] {
  const known = new Set(knownList);
  const items = includeFiles ? knipItems(k) : k.exports.map((e) => `export ${e}`);
  return items.filter((x) => !known.has(x)).map((msg) => ({ rule: "knip", file: msg.split(" ")[1].split(":")[0], line: 0, msg: `new unused ${msg}` }));
}

function testFails(o: Opts, t: Tests): Finding[] {
  if (o.entry !== "full" || !t.red || o.flags["allow-red-tests"]) return [];
  return [{ rule: "tests", file: ".", line: 0, msg: `tests red: ${redText(t)} (--allow-red-tests accepts red tests)` }];
}

export const redText = (t: Tests) => (t.failed !== null ? `${t.failed} failed` : `exit ${t.code}, failed count not found in tests.log`);

export function gate(o: Opts, a: Analysis, suppliedDebt?: Debt) {
  const state = baselineState(o);
  const adapterTools = a.adapterTools ?? [];
  const debt = currentDebt(o, a, state.missing, suppliedDebt);
  const base = state.value ?? baselineFromDebt(debt);
  const fn = gateFunctions(o, a, base);
  const core = check("crap", [...testFails(o, a.tests), ...fn.fails]);
  const deps = check("deps", depFails(a.deps, base));
  const toolKnown = base ? (base.tools ?? null) : [];
  const tools = ratchetAdapterChecks(adapterTools, toolKnown);
  const checks = [core, deps, knipCheck(a.knip, base, !state.missing), ...tools, ...a.checks];
  if (debt) checks.push(missingBaselineCheck(debt));
  return { checks, drift: [...fn.drift, ...meanDrift(o, a, base)], escalate: escalations(o, a.ch) };
}

function currentDebt(o: Opts, a: Analysis, missing: boolean, supplied?: Debt) {
  if (!missing || a.docsOnly || !hasDebtInput(a, a.adapterTools ?? [])) return null;
  return supplied ?? debtAtBase(o, a.adapterAudit ?? false);
}

function hasDebtInput(a: Analysis, tools: AdapterToolCheck[]) {
  return a.deps !== null || a.knip !== null || tools.some((item) => item.findings.length > 0);
}

function baselineFromDebt(debt: Debt | null): Baseline | null {
  return debt ? { head: "", functions: {}, deps: baseDeps(debt.deps), knip: baseKnip(debt.knip), tools: adapterFindingKeys(debt.tools ?? []) } : null;
}

function missingBaselineCheck(debt: Debt) {
  const cycles = debt.deps && !debt.deps.error ? debt.deps.cycles.length : 0;
  const entries = debt.knip && !debt.knip.error ? knipItems(debt.knip).length : 0;
  const tools = adapterFindingKeys(debt.tools ?? []).length;
  const adapter = tools ? ` / ${tools} adapter entries` : "";
  return notedCheck("baseline", [], "", [`baseline: missing, run --update-baseline; ${cycles} cycles / ${entries} knip entries${adapter} not judged`]);
}

function debtAtBase(o: Opts, includeAudit: boolean): Debt {
  return withBaseTree(o, (base) => ({ deps: depcruise(base), knip: knip(base), tools: projectAdapterChecks(base, includeAudit) }));
}

function withBaseTree<T>(o: Opts, read: (base: Opts) => T): T {
  const root = mkdtempSync(join(tmpdir(), "qg-base-"));
  try {
    return read(baseTreeOpts(o, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function baseTreeOpts(o: Opts, root: string): Opts {
  const tree = join(root, "tree");
  const archive = join(root, "base.tar");
  const ref = git(o.repo, "merge-base", o.base, "HEAD").trim();
  mkdirSync(tree);
  git(o.repo, "archive", "--format=tar", `--output=${archive}`, ref);
  const unpack = run("tar", ["-xf", archive, "-C", tree], o.repo);
  if (unpack.code !== 0) throw new Error(`cannot unpack ${ref} for missing-baseline comparison: ${unpack.err.trim()}`);
  linkNodeModules(o.repo, tree);
  const base = { ...o, repo: tree, out: join(tree, o.outDir), baseline: join(tree, o.outDir, "baseline.json") };
  mkdirSync(base.out, { recursive: true });
  return base;
}

export function adapterAuditGateChecks(o: Opts) {
  const current = adapterChecks(o, ["audit"]);
  if (!current.some((item) => item.findings.length > 0)) return current;
  if (o.scope.kind === "all") return ratchetAdapterChecks(current, []);
  const state = baselineState(o);
  if (!state.missing) return ratchetAdapterChecks(current, state.value?.tools ?? null);
  const known = withBaseTree(o, (base) => adapterFindingKeys(adapterChecks(base, ["audit"])));
  return ratchetAdapterChecks(current, known);
}

function linkNodeModules(repo: string, tree: string) {
  const source = join(repo, "node_modules");
  const target = join(tree, "node_modules");
  if (existsSync(source) && !existsSync(target)) symlinkSync(source, target, "dir");
}

// Paths that always go to the reviewer. The reviewer is not wired yet: this is a note, never a block.
function escalations(o: Opts, ch: Changes) {
  return [...ch.keys()].filter((f) => globMatch(o.toml.escalate.paths, f));
}

// Red tests give low coverage: such a snapshot is refused unless --allow-red-tests.
export function writeBaseline(o: Opts, a: Analysis) {
  const blocked = testFails(o, a.tests);
  if (blocked.length) return blocked.map((x) => `baseline not written, ${x.msg}`);
  if (!a.tests.used) return ["baseline not written: no coverage (run without --staged/--since, with tests)"];
  if (!a.fns.length && sourceFiles(o).length) return ["baseline not written: 0 functions found for non-empty project.src"];
  const head = git(o.repo, "rev-parse", "--short", "HEAD").trim();
  const snap = { head, created: new Date().toISOString(), mean: Number(meanCrap(a.fns).toFixed(4)), deps: baseDeps(a.deps), knip: baseKnip(a.knip), tools: adapterFindingKeys(a.adapterTools ?? []), functions: baseFns(a.fns) };
  mkdirSync(dirname(o.baseline), { recursive: true });
  writeFileSync(o.baseline, JSON.stringify(snap, null, 1));
  return [];
}

function baseFns(fns: Fn[]) {
  const out: Record<string, BaseFn> = {};
  for (const f of fns) out[f.key] = { line: f.start, cc: f.cc, crap: f.crap === null ? null : Number(f.crap.toFixed(3)) };
  return out;
}

const baseDeps = (d: Deps | null) => (d && !d.error ? { cycles: d.cycles.map((c) => c.key), layers: d.layers } : null);
const baseKnip = (k: Knip | null) => (k && !k.error ? knipItems(k) : undefined);

export const reportPath = (o: Opts, name: string) => join(o.out, name);
