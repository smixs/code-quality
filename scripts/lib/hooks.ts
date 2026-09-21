// git hooks (pre-commit, commit-msg, pre-push), hook install/uninstall and the agent Stop contract.
// Every entry point runs the same analysis; vendors only differ in how they call this file.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { type Args, buildOpts, CONFIG_FILE, type Opts, readArgs, repoConfigFile } from "./config.ts";
import { runTests } from "./crap.ts";
import { parseDiff, type Changes } from "./diff.ts";
import { diffCoverageCheck } from "./diffcov.ts";
import { adapterAuditGateChecks, analyze, gate } from "./gate.ts";
import { checkNotices, failCount, testsLine, verdictText, writeHookReport, writeReport } from "./report.ts";
import { defaultJev, type JevDeps, jevNotes } from "./jev.ts";
import { adapterForFile, isTestFile, siblingTestFiles } from "./lang.ts";
import { gitleaksCheck } from "./security.ts";
import { isProjectSource, tamperCheck } from "./tamper.ts";
import { commitMsgFindings } from "./text.ts";
import { bypassNote, check, type Check, emptyTree, findingLine, git, gitPaths, lines, notedCheck, refuse, run } from "./util.ts";

export const HOOKS_DIR = resolve(import.meta.dir, "../../hooks");
const ZERO = /^0+$/;

// ---- check: deterministic gate on the current change (seconds)

// ok is decided by the deterministic checks only; Jev lines are notes (owner decision 3).
export async function runCheck(o: Opts, jev: JevDeps = defaultJev()) {
  const a = analyze(o, "fresh-or-none");
  const g = gate(o, a);
  const report = writeReport(o, a, g, "check.md");
  const notes = o.toml.review.jev ? await jevNotes(o, a.ch, jev) : [];
  const verdict = verdictText(g.checks, a, false);
  const scope = a.docsOnly ? ["scope: docs-only"] : [];
  const text = [testsLine(a.tests), ...scope, verdict, ...checkNotices(g.checks), ...escalateLines(g.escalate), ...notes, ...llmLines(o), `report: ${report}`].join("\n");
  return { ok: failCount(g.checks) === 0, text, verdict };
}

// verdict = the deterministic red lines only; the Stop retry key is built from it, never from notes.
export type Verdict = { ok: boolean; text: string; verdict?: string };

const llmLines = (o: Opts) => (o.toml.review.llm ? ["note: [review] llm = true but the LLM reviewer is not wired yet; nothing ran"] : []);

const escalateLines = (xs: string[]) => (xs.length ? [`note: reviewer paths touched (not wired yet): ${xs.slice(0, 10).join(", ")}`] : []);

function exitWith(r: { ok: boolean; text: string }) {
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}

// ---- git hooks

// The analysis reads the working tree, so a file with unstaged edits would be judged by the wrong text.
function partlyStaged(o: Opts) {
  const staged = new Set(lines(gitPaths(o.repo, "diff", "--cached", "--name-only")));
  const both = lines(gitPaths(o.repo, "diff", "--name-only")).filter((f) => staged.has(f));
  if (!both.length) return null;
  return { ok: false, text: `pre-commit: partly staged, the gate reads the working tree: ${both.slice(0, 10).join(", ")}\nstage the whole file, or: git stash push --keep-index; git commit; git stash pop` };
}

function commitMsg(o: Opts, file: string) {
  const found = commitMsgFindings(o, readFileSync(file, "utf8"));
  if (found.length) console.error(`commit-msg: blocked\n${found.map(findingLine).join("\n")}`);
  process.exit(found.length ? 1 : 0);
}

type Push = { local: string; remote: string };

export function pushRanges(o: Opts, stdin: string): string[] {
  const refs: Push[] = lines(stdin).map((l) => l.split(" ")).map(([, local, , remote]) => ({ local, remote }));
  return refs.filter((r) => !ZERO.test(r.local)).map((r) => `${ZERO.test(r.remote) ? mergeBase(o, r.local) : r.remote}..${r.local}`);
}

// A new branch diffs from the merge base with project.base; without one (no origin/main yet) from the
// parent, and a root commit from the empty tree.
function mergeBase(o: Opts, sha: string) {
  const r = run("git", ["merge-base", o.base, sha], o.repo);
  if (r.code === 0) return r.out.trim();
  return run("git", ["rev-parse", "-q", "--verify", `${sha}~1`], o.repo).code === 0 ? `${sha}~1` : emptyTree(o.repo);
}

export function touchedTests(o: Opts, files: string[]) {
  return touchedTestSelection(o, files).tests;
}

function touchedTestSelection(o: Opts, files: string[]) {
  const named = existingNamedTests(o, files);
  const imported = importingTests(o, files).filter((file) => !named.includes(file));
  const max = Math.max(0, Math.floor(Number(o.toml.hooks.pre_push_max_tests)));
  const byName = named.slice(0, max);
  const byImport = imported.slice(0, Math.max(0, max - byName.length));
  return { tests: [...byName, ...byImport], byName: byName.length, byImport: byImport.length, omitted: named.length + imported.length - byName.length - byImport.length, max };
}

function existingNamedTests(o: Opts, files: string[]) {
  const candidates = files.flatMap((file) => (isTestFile(o.langs, file) ? [file] : siblingTestFiles(o.langs, file)));
  return [...new Set(candidates)].filter((file) => existsSync(join(o.repo, file))).sort();
}

function importingTests(o: Opts, files: string[]) {
  const sources = files.filter((file) => isProjectSource(o, file) && adapterForFile(o.langs, file)?.id === "ts");
  if (!sources.length) return [];
  const aliases = tsAliases(o.repo);
  const tests = lines(gitPaths(o.repo, "ls-files")).filter((file) => isTestFile(o.langs, file) && adapterForFile(o.langs, file)?.id === "ts").sort();
  return tests.filter((test) => testImportsSource(o.repo, test, sources, aliases));
}

type Alias = { pattern: string; target: string };

function testImportsSource(repo: string, test: string, sources: string[], aliases: Alias[]) {
  const path = join(repo, test);
  if (!existsSync(path)) return false;
  const modules = [...readFileSync(path, "utf8").matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  return modules.some((module) => sources.some((source) => importTargets(test, module, source, aliases)));
}

function importTargets(test: string, module: string, source: string, aliases: Alias[]) {
  if (module.startsWith(".")) return sameModule(source, normalize(join(dirname(test), module)));
  return aliases.some((alias) => sameModule(source, expandAlias(alias, module)));
}

function sameModule(source: string, target: string) {
  if (!target) return false;
  const from = stripModuleExt(normalize(source));
  const to = stripModuleExt(normalize(target));
  return from === to || from === `${to}/index`;
}

const stripModuleExt = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "");

function expandAlias(alias: Alias, module: string) {
  const star = alias.pattern.indexOf("*");
  if (star < 0) return alias.pattern === module ? alias.target : "";
  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!module.startsWith(prefix) || !module.endsWith(suffix)) return "";
  return alias.target.replace("*", module.slice(prefix.length, module.length - suffix.length));
}

function tsAliases(repo: string): Alias[] {
  const path = join(repo, "tsconfig.json");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const body = /["']paths["']\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const base = /["']baseUrl["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? ".";
  return [...body.matchAll(/["']([^"']+)["']\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[2].matchAll(/["']([^"']+)["']/g)].map((target) => ({ pattern: match[1], target: normalize(join(base, target[1])) })));
}

function prePushCmd(o: Opts) {
  if (o.toml.hooks.pre_push_test_cmd) return o.toml.hooks.pre_push_test_cmd;
  return o.lang === "py" ? "uv run --with pytest pytest -q {files}" : "node --test {files}";
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function prePush(o: Opts, stdin: string) {
  const security = [gitleaksCheck(o), ...adapterAuditGateChecks(o)];
  const ranges = pushRanges(o, stdin);
  const ch = pushedChanges(o, ranges);
  const tamper = pushedTamperCheck(o, ranges);
  const files = ranges.flatMap((r) => lines(gitPaths(o.repo, "diff", "--name-only", r)));
  const touched = touchedTestSelection(o, files);
  const tests = touched.tests;
  const touchedLine = `touched tests: ${touched.byName} by name, ${touched.byImport} by import${touched.omitted ? `, ${touched.omitted} omitted by hooks.pre_push_max_tests=${touched.max}` : ""}`;
  const sourceChanged = files.some((f) => isProjectSource(o, f));
  const noTest = noTestCheck(o, ranges, sourceChanged, tests.length);
  const baseChecks = [tamper, noTest, ...security];
  if (noTest.findings.length) return finishPrePush(o, { ok: false, text: touchedLine }, baseChecks);
  const test = tests.length ? runTouchedTests(o, tests, touchedLine) : { ok: true, text: `${touchedLine}\npre-push: no touched tests` };
  if (!test.ok) return finishPrePush(o, test, baseChecks);
  const coverage = diffCoverageCheck(o, ch, runTests(o, "fresh-or-none"), { lowCoverage: true, missingFiles: false });
  return finishPrePush(o, test, [...baseChecks, coverage]);
}

function finishPrePush(o: Opts, result: { ok: boolean; text: string }, checks: Check[]) {
  writeHookReport(o, "pre-push", checks);
  const text = checks.flatMap(checkOutput);
  return { ok: result.ok && failCount(checks) === 0, text: [result.text, ...text].filter(Boolean).join("\n") };
}

function checkOutput(item: Check) {
  if (item.error) return [`${item.name}: ERROR ${item.error}`];
  if (item.findings.length) return item.findings.map(findingLine);
  return item.notices.length ? item.notices : item.note ? [item.note] : [];
}

function runTouchedTests(o: Opts, tests: string[], touchedLine: string) {
  const cmd = prePushCmd(o).replace("{files}", tests.map(shq).join(" "));
  const log = join(o.out, "pre-push.log");
  const t0 = Date.now();
  const r = run("sh", ["-c", `${cmd} > ${shq(log)} 2>&1`], o.repo, { timeout: o.toml.hooks.pre_push_timeout * 1000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const why = r.code === 0 ? "pass" : r.code === -1 ? `timeout after ${o.toml.hooks.pre_push_timeout}s` : `exit ${r.code}`;
  return { ok: r.code === 0, text: `${touchedLine}\npre-push: ${tests.length} touched test file(s) ${why} in ${secs}s, log ${log}` };
}

function noTestCheck(o: Opts, ranges: string[], sourceChanged: boolean, tests: number) {
  if (!sourceChanged || tests) return check("tamper/no-tests-ran", []);
  const reason = ranges.map((range) => noTestReason(run("git", ["log", "--format=%B", range], o.repo).out)).find(Boolean);
  if (reason) return notedCheck("tamper/no-tests-ran", [], "", [bypassNote("tamper/no-tests-ran", "commit-msg", reason)]);
  return check("tamper/no-tests-ran", [{ rule: "tamper/no-tests-ran", file: ".", line: 0, msg: "source changed, no test touched or found; add/refer a test or qg:no-test <reason>" }]);
}

const noTestReason = (text: string) => /(?:^|\s)qg:no-test\s+(\S.*)$/m.exec(text)?.[1].trim() ?? "";

function pushedChanges(o: Opts, ranges: string[]): Changes {
  const ch: Changes = new Map();
  for (const range of ranges) parseDiff(gitPaths(o.repo, "diff", "-U0", "--no-color", "--no-ext-diff", range), ch);
  return ch;
}

function pushedTamperCheck(o: Opts, ranges: string[]): Check {
  const checks = pushedCommits(o, ranges).map((sha) => tamperAtCommit(o, sha));
  return notedCheck("tamper", unique(checks.flatMap((item) => item.findings), findingLine), "", unique(checks.flatMap((item) => item.notices)));
}

function pushedCommits(o: Opts, ranges: string[]) {
  const commits = ranges.flatMap((range) => lines(git(o.repo, "rev-list", "--reverse", "--first-parent", range)));
  return [...new Set(commits)];
}

function tamperAtCommit(o: Opts, sha: string) {
  const parentResult = run("git", ["rev-parse", "-q", "--verify", `${sha}^`], o.repo);
  const parent = parentResult.code === 0 ? parentResult.out.trim() : emptyTree(o.repo);
  const diff = gitPaths(o.repo, "diff", "-U0", "--no-color", "--no-ext-diff", parent, sha);
  const message = git(o.repo, "show", "-s", "--format=%B", sha);
  return tamperCheck(o, parseDiff(diff), { allowFile: false, commitMessages: message, configBefore: configAt(o, parent), configAfter: configAt(o, sha) });
}

function configAt(o: Opts, ref: string) {
  const result = run("git", ["show", `${ref}:.quality.toml`], o.repo);
  return result.code === 0 ? result.out : "";
}

function unique<T>(items: T[], key: (item: T) => string = String) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export async function runHook(args: Args) {
  const [, name, file] = args.positionals;
  const o = buildOpts({ ...args, values: { ...args.values, staged: name === "pre-commit" } });
  if (name === "pre-commit") return exitWith(partlyStaged(o) ?? (await runCheck(o)));
  if (name === "commit-msg") return commitMsg(o, file);
  if (name === "pre-push") return exitWith(prePush(o, readFileSync(0, "utf8")));
  refuse(`unknown hook ${name}; expected pre-commit | commit-msg | pre-push`);
}

// ---- install / uninstall: core.hooksPath for this repo only
// Setting core.hooksPath hides the repo's own hooks (Git LFS, husky, ...), so every wrapper in hooks/
// chains to the hook git would have run (hooks/_chain). A previous core.hooksPath (husky's .husky/_)
// is kept in code-quality.previousHooksPath: _chain runs hooks from there, uninstall restores it.

export const PREV_KEY = "code-quality.previousHooksPath";

function scopedConfig(repo: string, scope: string, key: string) {
  return run("git", ["config", `--${scope}`, "--type=path", "--get", key], repo).out.trim();
}
const localConfig = (repo: string, key: string) => scopedConfig(repo, "local", key);

function repoRoot(path: string | undefined) {
  if (!path) refuse("usage: quality.ts install-hooks|uninstall-hooks <repo>");
  return git(resolve(path), "rev-parse", "--show-toplevel").trim();
}

export function installHooks(path: string | undefined) {
  const repo = repoRoot(path);
  const cur = localConfig(repo, "core.hooksPath");
  if (cur && cur !== HOOKS_DIR) git(repo, "config", "--local", PREV_KEY, cur);
  git(repo, "config", "--local", "core.hooksPath", HOOKS_DIR);
  console.log([`hooks installed: ${repo} core.hooksPath=${HOOKS_DIR}`, chainNote(repo), ...installNotes(repo)].join("\n"));
}

// The directory _chain reads: the recorded previous core.hooksPath, else a --global/--system
// core.hooksPath (relative = from the work tree), else <common dir>/hooks.
function chainDir(repo: string) {
  const prev = localConfig(repo, PREV_KEY) || scopedConfig(repo, "global", "core.hooksPath") || scopedConfig(repo, "system", "core.hooksPath");
  if (prev) return resolve(repo, prev);
  return join(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "hooks");
}

const executable = (path: string) => existsSync(path) && statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;

function chainNote(repo: string) {
  const dir = chainDir(repo);
  const own = existsSync(dir) ? readdirSync(dir).filter((f) => existsSync(join(HOOKS_DIR, f)) && executable(join(dir, f))) : [];
  return `chained repo hooks from ${dir}: ${own.length ? own.join(", ") : "none"}`;
}

function installNotes(repo: string) {
  const out: string[] = [];
  if (!repoConfigFile(repo)) out.push(`note: no ${CONFIG_FILE}; defaults are used`);
  if (!existsSync(buildOpts(readArgs([`--repo=${repo}`])).baseline)) out.push(`warn: no baseline yet; existing cycles and knip entries are reported but not judged, and new debt is compared with project.base; run once: bun ${resolve(import.meta.dir, "../quality.ts")} --repo ${repo} --update-baseline`);
  if (run("git", ["check-ignore", "-q", ".scratch/quality/x"], repo).code !== 0) out.push("warn: .scratch/ is not in .gitignore; reports land in .scratch/quality");
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  if (common !== join(repo, ".git")) out.push(`note: ${repo} is a worktree; the setting lives in ${common}/config and covers every worktree of this repo`);
  return out;
}

export function uninstallHooks(path: string | undefined) {
  const repo = repoRoot(path);
  const cur = localConfig(repo, "core.hooksPath");
  if (cur !== HOOKS_DIR) return console.log(`nothing to do: core.hooksPath is ${cur || "unset"}${dropStalePrevious(repo)}`);
  console.log(`hooks removed: ${repo}${restorePrevious(repo)}`);
}

// A recorded previous path without our core.hooksPath (husky rewrote it, or it was set by hand) is stale.
function dropStalePrevious(repo: string) {
  if (!localConfig(repo, PREV_KEY)) return "";
  git(repo, "config", "--local", "--unset", PREV_KEY);
  return `; removed stale ${PREV_KEY}`;
}

function restorePrevious(repo: string) {
  const prev = localConfig(repo, PREV_KEY);
  if (!prev) {
    git(repo, "config", "--local", "--unset", "core.hooksPath");
    return "";
  }
  git(repo, "config", "--local", "core.hooksPath", prev);
  git(repo, "config", "--local", "--unset", PREV_KEY);
  return `, core.hooksPath restored to ${prev}`;
}

// ---- agent Stop: one JSON contract shared by Claude Code and Codex (pi calls it too)
// stdin {cwd, session_id}; stdout {} to allow, {decision:"block", reason} to continue.
// One block per distinct red verdict per session, tracked here: stop_hook_active is also true when
// another Stop hook blocked, so it cannot tell whether this gate already had its retry.

function stopInput() {
  const raw = readFileSync(0, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    // Exit 1, not 2: for Claude Code exit 2 means "block", and a broken caller would trap the agent.
    console.error(`agent-stop: stdin is not the Stop hook JSON: ${raw.slice(0, 120)}`);
    process.exit(1);
  }
}

const markerPath = (repo: string) => join(repo, ".scratch/quality/stop-block.json");

function alreadyBlocked(repo: string, key: string) {
  const path = markerPath(repo);
  return existsSync(path) && readFileSync(path, "utf8") === key;
}

function remember(repo: string, key: string) {
  mkdirSync(dirname(markerPath(repo)), { recursive: true });
  writeFileSync(markerPath(repo), key);
}

function stopRepo(cwd: string) {
  const r = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) return "";
  const repo = r.out.trim();
  return repoConfigFile(repo) ? repo : "";
}

async function stopVerdict(args: Args, repo: string): Promise<Verdict> {
  try {
    return await runCheck(buildOpts({ ...args, values: { ...args.values, repo } }));
  } catch (e) {
    return { ok: false, text: `quality gate crashed: ${(e as Error).message}` };
  }
}

// A session judges only when it touched the repo: a dirty --src path, or HEAD moved since this
// session's last Stop. The first Stop of a session with a clean tree records HEAD and allows: its
// commits, if any, already went through pre-commit.
const headsPath = (repo: string) => join(repo, ".scratch/quality/stop-heads.json");

function readHeads(repo: string): Record<string, string> {
  const path = headsPath(repo);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function sessionTouched(args: Args, repo: string, session: string) {
  try {
    const dirs = buildOpts({ ...args, values: { ...args.values, repo } }).dirs;
    const dirty = git(repo, "status", "--porcelain", "--", ...dirs).trim() !== "";
    const head = run("git", ["rev-parse", "HEAD"], repo).out.trim();
    const heads = readHeads(repo);
    const moved = session in heads && heads[session] !== head;
    const kept = Object.entries({ ...heads, [session]: head }).slice(-50);
    mkdirSync(dirname(headsPath(repo)), { recursive: true });
    writeFileSync(headsPath(repo), JSON.stringify(Object.fromEntries(kept)));
    return dirty || moved;
  } catch {
    // Cannot tell (broken config or state file): judge, so stopVerdict reports the real error.
    return true;
  }
}

export async function agentStop(args: Args) {
  const input = stopInput();
  const session = input.session_id ?? "";
  const repo = stopRepo(input.cwd ?? process.cwd());
  const r = await stopResult(args, repo, session);
  console.log(JSON.stringify(r.ok ? {} : redAnswer(repo, session, r)));
}

async function stopResult(args: Args, repo: string, session: string): Promise<Verdict> {
  if (!repo || !sessionTouched(args, repo, session)) return { ok: true, text: "" };
  return stopVerdict(args, repo);
}

// The key holds only the deterministic red lines: a Jev note that changes (timeout, drift) between two
// Stops must not count as a new verdict and block the agent a second time.
export function redAnswer(repo: string, session: string, r: Verdict) {
  const key = JSON.stringify([session, r.verdict ?? r.text]);
  if (alreadyBlocked(repo, key)) return { systemMessage: `quality gate still red after one retry:\n${r.text}` };
  remember(repo, key);
  return { decision: "block", reason: `Quality gate is red in ${repo}. Fix before finishing:\n${r.text}` };
}
