// git hooks (pre-commit, commit-msg, pre-push), hook install/uninstall and the agent Stop contract.
// Every entry point runs the same analysis; vendors only differ in how they call this file. No hook
// stops the agent: red flags go first and loud, findings follow, the commit, push or stop goes ahead.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Args, buildOpts, CONFIG_FILE, DEFAULTS, type Opts, readArgs, repoConfigFile } from "./config.ts";
import { runTests } from "./crap.ts";
import { parseDiff, type Changes } from "./diff.ts";
import { diffCoverageCheck } from "./diffcov.ts";
import { acceptanceTests, type Lane } from "./accept.ts";
import { adapterAuditGateChecks, type Analysis, analyze, gate } from "./gate.ts";
import { checkNotices, failCount, isRedFlag, redFlag, redFlags, testsLine, verdictText, writeHookReport, writeReport } from "./report.ts";
import { defaultJev, type JevDeps, jevNotes } from "./jev.ts";
import { adapterById, prePushTestCommand } from "./lang.ts";
import { runTestProcess } from "./testrun.ts";
import { gitleaksCheck } from "./security.ts";
import { isProjectSource, tamperCheck } from "./tamper.ts";
import { commitMsgFindings } from "./text.ts";
import { noTestCheck, touchedTestSelection } from "./touched.ts";
import { type Check, emptyTree, findingLine, git, gitPaths, lines, notedCheck, refuse, run, shq } from "./util.ts";

export { touchedTests } from "./touched.ts";

export const SOURCE_HOOKS_DIR = resolve(import.meta.dir, "../../git-hooks");
export const LEGACY_HOOKS_DIR = resolve(import.meta.dir, "../../hooks");
const PLUGIN_ROOT = resolve(import.meta.dir, "../..");
export const pluginHome = () => resolve(process.env.CODE_QUALITY_HOME || join(homedir(), ".local/share/code-quality"));
export const hooksDir = () => join(pluginHome(), "git-hooks");

// The shims in git-hooks/ run the copy named in hooks-root. Every agent runs its own copy (the Claude
// Code and Codex caches, pi, omp, Grok) and a session keeps the one it started with, so a copy takes
// the hooks only when it is not older than the copy named there, or that copy is gone; install-hooks
// takes them outright. Shims up to 1.2.0 read `root`, the last invoked copy: on 26.09 a pi session
// still on 1.0.0 rewrote it seconds before a push, and the push ran 1.0.0. `root` is kept for them.
// Only agent-stop and guard-bash call this: on 27.09 copies run by hand from worktrees took the hooks
// of every repo on the machine three times.
export function updatePluginRoot() {
  const home = writeRoot();
  if (takesHooks(home)) pointHooks(home);
}

function writeRoot() {
  const home = pluginHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "root"), PLUGIN_ROOT + "\n");
  return home;
}

function takesHooks(home: string) {
  const theirs = copyVersion(readText(join(home, "hooks-root")).trim());
  return !theirs || Bun.semver.order(copyVersion(PLUGIN_ROOT) || "0.0.0", theirs) >= 0;
}

// "" when the copy is gone or has no version.
function copyVersion(root: string) {
  if (!root) return "";
  const version = /"version"\s*:\s*"([^"]+)"/.exec(readText(join(root, "package.json")))?.[1] ?? "";
  return /^\d+\.\d+\.\d+/.test(version) ? version : "";
}

// Points the shims at this copy and brings installed shims to its version. Each file is replaced by a
// rename, so a hook that is running keeps reading the old one.
function pointHooks(home: string) {
  writeChanged(join(home, "hooks-root"), PLUGIN_ROOT + "\n", 0o644);
  const target = join(home, "git-hooks");
  if (!existsSync(target)) return;
  for (const name of readdirSync(SOURCE_HOOKS_DIR)) writeChanged(join(target, name), readFileSync(join(SOURCE_HOOKS_DIR, name), "utf8"), 0o755);
}

function writeChanged(path: string, text: string, mode: number) {
  if (readText(path) === text) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const ZERO = /^0+$/;

// ---- check: deterministic gate on the current change (seconds)

// ok = no deterministic finding (the exit code of `check`); Jev lines are notes. Red flags go first.
// check --tests runs the touched tests first and the analysis reads their coverage in this process.
export async function runCheck(o: Opts, jev: JevDeps = defaultJev()) {
  const lane = o.flags.tests === true ? await acceptanceTests(o) : null;
  const a = analyze(o, "fresh-or-none", lane?.tests);
  if (lane) a.checks.push(...lane.checks);
  if (lane?.dir && !lane.failed) a.tests.removed = true;
  const g = gate(o, a);
  const report = writeReport(o, a, g, "check.md");
  const notes = o.toml.review.jev ? await jevNotes(o, a.ch, jev) : [];
  const verdict = verdictText(g.checks, a, false);
  const text = [...checkHead(g.checks, a, lane), verdict, ...checkNotices(g.checks), ...escalateLines(g.escalate), ...notes, ...llmLines(o), ...laneDir(lane), `report: ${report}`].join("\n");
  return { ok: failCount(g.checks) === 0, text, verdict };
}

// Red flags first, then what ran and on what scope.
function checkHead(checks: Check[], a: Analysis, lane: Lane | null) {
  return [...redFlags(checks), ...(lane ? lane.lines : [testsLine(a.tests)]), ...(a.docsOnly ? ["scope: docs-only"] : [])];
}

// The private run directory goes after the verdict; a failed run keeps it and says where.
function laneDir(lane: Lane | null) {
  if (!lane?.dir) return [];
  if (lane.failed) return [`tests: run files kept at ${lane.dir}`];
  rmSync(lane.dir, { recursive: true, force: true });
  return [];
}

// verdict = the deterministic lines only; the Stop "already shown" key is built from it, never from notes.
export type Verdict = { ok: boolean; text: string; verdict?: string };

const llmLines = (o: Opts) => (o.toml.review.llm ? ["note: [review] llm = true but the LLM reviewer is not wired yet; nothing ran"] : []);

const escalateLines = (xs: string[]) => (xs.length ? [`note: reviewer paths touched (not wired yet): ${xs.slice(0, 10).join(", ")}`] : []);

// A git hook prints its advice and lets git go on: exit 0 whatever it found.
function advise(...text: string[]) {
  console.log(text.filter(Boolean).join("\n"));
  process.exit(0);
}

// ---- git hooks

// The analysis reads the working tree, so a file with unstaged edits is judged by its working-tree text.
function partlyStaged(o: Opts) {
  const staged = new Set(lines(gitPaths(o.repo, "diff", "--cached", "--name-only")));
  const both = lines(gitPaths(o.repo, "diff", "--name-only")).filter((f) => staged.has(f));
  if (!both.length) return "";
  return `note: partly staged, the report below reads the working tree, not the commit: ${both.slice(0, 10).join(", ")}`;
}

function commitMsg(o: Opts, file: string) {
  const found = commitMsgFindings(o, readFileSync(file, "utf8"));
  if (found.length) console.error(`commit-msg: note, the commit goes ahead\n${found.map(findingLine).join("\n")}`);
  process.exit(0);
}

type Push = { ref: string; local: string; remote: string };
type Pushed = { ref: string; local: string; range: string };

// One entry per pushed ref that is not a deletion: its local ref, its sha, and the range it adds.
function pushedRefs(o: Opts, stdin: string): Pushed[] {
  const refs: Push[] = lines(stdin).map((l) => l.split(" ")).map(([ref, local, , remote]) => ({ ref, local, remote }));
  return refs.filter((r) => !ZERO.test(r.local)).map((r) => ({ ref: r.ref, local: r.local, range: `${ZERO.test(r.remote) ? mergeBase(o, r.local) : r.remote}..${r.local}` }));
}

export function pushRanges(o: Opts, stdin: string): string[] {
  return pushedRefs(o, stdin).map((p) => p.range);
}

// A new branch diffs from the merge base with project.base; without one (no origin/main yet) from the
// parent, and a root commit from the empty tree.
function mergeBase(o: Opts, sha: string) {
  const r = run("git", ["merge-base", o.base, sha], o.repo);
  if (r.code === 0) return r.out.trim();
  return run("git", ["rev-parse", "-q", "--verify", `${sha}~1`], o.repo).code === 0 ? `${sha}~1` : emptyTree(o.repo);
}

function prePushCmd(o: Opts) {
  return o.toml.hooks.pre_push_test_cmd || prePushTestCommand(adapterById(o.lang));
}

export async function prePush(o: Opts, stdin: string) {
  const security = [gitleaksCheck(o), ...adapterAuditGateChecks(o)];
  const pushed = pushedRefs(o, stdin);
  const ranges = pushed.map((p) => p.range);
  const ch = pushedChanges(o, ranges);
  const tamper = pushedTamperCheck(o, ranges);
  const files = ranges.flatMap((r) => lines(gitPaths(o.repo, "diff", "--name-only", r)));
  const touched = touchedTestSelection(o, files);
  const tests = touched.tests;
  const touchedLine = `touched tests: ${touched.byName} by name, ${touched.byImport} by import${touched.omitted ? `, ${touched.omitted} omitted by hooks.pre_push_max_tests=${touched.max}` : ""}`;
  const sourceChanged = files.some((f) => isProjectSource(o, f));
  const noTest = pushNoTestCheck(o, ranges, sourceChanged, tests.length);
  const baseChecks = [tamper, noTest, ...security];
  if (noTest.findings.length) return finishPrePush(o, { ok: false, text: touchedLine }, baseChecks);
  const tree = tests.length ? treeProblem(o, pushed, tests) : "";
  if (tree) return finishPrePush(o, { ok: false, text: `${touchedLine}\n${tree}` }, baseChecks);
  const test = tests.length ? await runTouchedTests(o, tests, touchedLine) : { ok: true, text: `${touchedLine}\npre-push: no touched tests` };
  if (!test.ok) return finishPrePush(o, test, baseChecks);
  const coverage = diffCoverageCheck(o, ch, runTests(o, "fresh-or-none"), { lowCoverage: true, missingFiles: false });
  return finishPrePush(o, test, [...baseChecks, coverage]);
}

type PushTests = { ok: boolean; text: string; flag?: string };

// Red flags first (red touched tests, tampered tests, secrets), then the rest; the push goes ahead.
function finishPrePush(o: Opts, result: PushTests, checks: Check[]) {
  writeHookReport(o, "pre-push", checks);
  const text = checks.flatMap(checkOutput);
  const flags = [...(result.flag ? [result.flag] : []), ...redFlags(checks)];
  return { ok: result.ok && failCount(checks) === 0, text: [...flags, result.text, ...text].filter(Boolean).join("\n") };
}

function checkOutput(item: Check) {
  if (item.error) return [`${item.name}: ERROR ${item.error}`];
  if (item.findings.length) return item.findings.filter((f) => !isRedFlag(f)).map(findingLine);
  return item.notices.length ? item.notices : item.note ? [item.note] : [];
}

// The touched tests (and the coverage check after them) read the checked-out tree, so the verdict
// belongs to the pushed commit only when that tree is it: every pushed ref that adds files peels to
// HEAD, and the files of the pushed ranges and the selected tests have no uncommitted changes.
// Dirt elsewhere in a shared checkout does not matter.
function treeProblem(o: Opts, pushed: Pushed[], tests: string[]) {
  const head = git(o.repo, "rev-parse", "HEAD").trim();
  const withFiles = pushed.map((p) => ({ ...p, files: lines(gitPaths(o.repo, "diff", "--name-only", p.range)) })).filter((p) => p.files.length);
  const other = withFiles.find((p) => git(o.repo, "rev-parse", `${p.local}^{commit}`).trim() !== head);
  const short = (sha: string) => git(o.repo, "rev-parse", "--short", sha).trim();
  if (other) return `pre-push: touched tests not run: pushing ${short(other.local)} (${other.ref}), this checkout is at ${short(head)}; they run on the checked-out tree, push from a checkout of that commit to run them`;
  const paths = [...new Set([...withFiles.flatMap((p) => p.files), ...tests])];
  const dirty = lines(gitPaths(o.repo, "status", "--porcelain", "--untracked-files=all", "--", ...paths)).map((line) => line.slice(3));
  return dirty.length ? `pre-push: touched tests not run: uncommitted changes in files they read: ${dirty.slice(0, 10).join(", ")}; commit or stash them to run the tests` : "";
}

async function runTouchedTests(o: Opts, tests: string[], touchedLine: string): Promise<PushTests> {
  const cmd = prePushCmd(o).replace("{files}", tests.map(shq).join(" "));
  const r = await runTestProcess(o, { cmd, log: join(o.out, "pre-push.log"), timeoutS: o.toml.hooks.pre_push_timeout });
  const why = r.timedOut ? `timeout after ${o.toml.hooks.pre_push_timeout}s` : r.code === 0 ? "pass" : `exit ${r.code}`;
  const red = !r.timedOut && r.code !== 0;
  const flag = red ? redFlag(`pushing with red tests: ${tests.length} touched test file(s) ${why}`, "the pushed commit breaks what its own tests check", `read ${r.log}; fix it, or say in the PR why red is expected`) : undefined;
  return { ok: r.code === 0 && !r.timedOut, text: `${touchedLine}\npre-push: ${tests.length} touched test file(s) ${why} in ${r.secs}s, log ${r.log}`, flag };
}

function pushNoTestCheck(o: Opts, ranges: string[], sourceChanged: boolean, tests: number) {
  return noTestCheck(sourceChanged, tests, ranges.map((range) => run("git", ["log", "--format=%B", range], o.repo).out).join("\n"));
}

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
  if (name === "pre-commit") return advise(partlyStaged(o), (await runCheck(o)).text);
  if (name === "commit-msg") return commitMsg(o, file);
  if (name === "pre-push") return advise((await prePush(o, readFileSync(0, "utf8"))).text);
  refuse(`unknown hook ${name}; expected pre-commit | commit-msg | pre-push`);
}

// ---- install / uninstall: core.hooksPath for this repo only
// Setting core.hooksPath hides the repo's own hooks (Git LFS, husky, ...), so every wrapper in git-hooks/
// chains to the hook git would have run (_chain). A previous core.hooksPath (husky's .husky/_)
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
  const target = hooksDir();
  if (cur && cur !== target && cur !== LEGACY_HOOKS_DIR) git(repo, "config", "--local", PREV_KEY, cur);
  mkdirSync(target, { recursive: true });
  pointHooks(writeRoot());
  git(repo, "config", "--local", "core.hooksPath", target);
  console.log([`hooks installed: ${repo} core.hooksPath=${target}`, chainNote(repo), ...installNotes(repo)].join("\n"));
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
  const own = existsSync(dir) ? readdirSync(dir).filter((f) => existsSync(join(hooksDir(), f)) && executable(join(dir, f))) : [];
  return `chained repo hooks from ${dir}: ${own.length ? own.join(", ") : "none"}`;
}

function installNotes(repo: string) {
  const out: string[] = [];
  const o = buildOpts(readArgs([`--repo=${repo}`]));
  if (!repoConfigFile(repo)) out.push(`note: no ${CONFIG_FILE}; defaults are used`);
  if (!existsSync(o.baseline)) out.push(`warn: no baseline yet; existing cycles and knip entries are reported but not judged, and new debt is compared with project.base; run once: bun ${resolve(import.meta.dir, "../quality.ts")} --repo ${repo} --update-baseline`);
  if (run("git", ["check-ignore", "-q", `${o.outDir}/x`], repo).code !== 0) out.push(`warn: ${o.outDir} is not ignored by git; reports land there`);
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  if (common !== join(repo, ".git")) out.push(`note: ${repo} is a worktree; the setting lives in ${common}/config and covers every worktree of this repo`);
  return out;
}

export function uninstallHooks(path: string | undefined) {
  const repo = repoRoot(path);
  const cur = localConfig(repo, "core.hooksPath");
  if (cur !== hooksDir() && cur !== LEGACY_HOOKS_DIR) return console.log(`nothing to do: core.hooksPath is ${cur || "unset"}${dropStalePrevious(repo)}`);
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

// ---- agent Stop: one JSON contract shared by Claude Code and Codex (pi, omp and OpenCode call it too)
// stdin {cwd, session_id[, deliver:"inline"]}; stdout {} or {systemMessage}. The Stop never holds the
// turn: a verdict with findings this session has not seen yet becomes a note for the agent's next turn.
// Claude Code and Codex read it through agent-notes (UserPromptSubmit), an adapter asks for it inline
// ({note}) and hands it to its own next-turn channel. The user sees a short systemMessage now.

function stopInput() {
  const raw = readFileSync(0, "utf8");
  try {
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object");
    return input;
  } catch {
    // Exit 1, not 2: for Claude Code exit 2 means "block", and the Stop never holds the agent.
    console.log(JSON.stringify({ systemMessage: "code-quality Stop hook received invalid JSON input" }));
    console.error("agent-stop: stdin is not the Stop hook JSON");
    process.exit(1);
  }
}

const markerPath = (repo: string, outDir: string) => join(repo, outDir, "stop-note.json");

function alreadyShown(state: StopState, key: string) {
  const path = markerPath(state.repo, state.outDir);
  return existsSync(path) && readFileSync(path, "utf8") === key;
}

function remember(state: StopState, key: string) {
  const path = markerPath(state.repo, state.outDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key);
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
const headsPath = (state: StopState) => join(state.repo, state.outDir, "stop-heads.json");

function readHeads(state: StopState): Record<string, string> {
  const path = headsPath(state);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function sessionTouched(args: Args, state: StopState, session: string) {
  const repo = state.repo;
  try {
    const dirs = buildOpts({ ...args, values: { ...args.values, repo } }).dirs;
    const dirty = git(repo, "status", "--porcelain", "--", ...dirs).trim() !== "";
    const head = run("git", ["rev-parse", "HEAD"], repo).out.trim();
    const heads = readHeads(state);
    const moved = session in heads && heads[session] !== head;
    const kept = Object.entries({ ...heads, [session]: head }).slice(-50);
    mkdirSync(dirname(headsPath(state)), { recursive: true });
    writeFileSync(headsPath(state), JSON.stringify(Object.fromEntries(kept)));
    return dirty || moved;
  } catch {
    // Cannot tell (broken config or state file): judge, so stopVerdict reports the real error.
    return true;
  }
}

// The repo and the directory its state files live in: the default out_dir stands in when the config
// cannot be read, so a broken config still gets its note.
export type StopState = { repo: string; outDir: string };

function stopState(args: Args, repo: string): StopState {
  try {
    return { repo, outDir: buildOpts({ ...args, values: { ...args.values, repo } }).outDir };
  } catch {
    return { repo, outDir: DEFAULTS.project.out_dir };
  }
}

export async function agentStop(args: Args) {
  try {
    const input = stopInput();
    const session = input.session_id ?? input.sessionId ?? "";
    if (typeof session !== "string" || !session.trim()) throw new Error("missing session_id/sessionId");
    const state = stopState(args, stopRepo(input.cwd ?? process.cwd()));
    const r = await stopResult(args, state, session);
    const note = r.ok ? "" : stopNote(state, session, r);
    console.log(JSON.stringify(stopAnswer(note, session, input.deliver === "inline")));
  } catch (error) {
    console.log(JSON.stringify({ systemMessage: `code-quality Stop hook failed: ${(error as Error).message}` }));
    process.exit(1);
  }
}

async function stopResult(args: Args, state: StopState, session: string): Promise<Verdict> {
  if (!state.repo || !sessionTouched(args, state, session)) return { ok: true, text: "" };
  return stopVerdict(args, state.repo);
}

// The key holds only the deterministic lines: a Jev note that changes (timeout, drift) between two
// Stops must not count as a new verdict and show the same findings again. "" = already shown.
export function stopNote(state: StopState, session: string, r: Verdict) {
  const key = JSON.stringify([session, r.verdict ?? r.text]);
  if (alreadyShown(state, key)) return "";
  remember(state, key);
  return `code-quality report for ${state.repo} (advice; the turn was not held, you decide what to act on):\n${r.text}`;
}

// inline: the adapter delivers the note itself. Otherwise it waits for agent-notes, and the user gets
// the red flags and the verdict line now.
export function stopAnswer(note: string, session: string, inline: boolean) {
  if (!note) return {};
  if (inline) return { note };
  queueNote(session, note);
  const head = note.split("\n").filter((line) => /^(RED FLAG|FINDINGS|quality gate crashed)/.test(line));
  return { systemMessage: ["code-quality (advice, nothing blocked):", ...head, "the agent gets the full report with the next message"].join("\n") };
}

// ---- agent-notes: UserPromptSubmit hands the queued Stop note to the agent once, then drops it.
// stdin {session_id}; stdout {} or {hookSpecificOutput:{hookEventName, additionalContext}}.
// Claude Code takes up to 10 000 characters of context; the rest is in the report file.
const NOTE_MAX = 9000;
const notePath = (session: string) => join(pluginHome(), "notes", `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.txt`);

function queueNote(session: string, note: string) {
  const path = notePath(session);
  mkdirSync(dirname(path), { recursive: true });
  const report = note.split("\n").find((line) => line.startsWith("report: ")) ?? "";
  writeFileSync(path, note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}\n... cut, the rest is in the ${report || "report file"}` : note);
}

// The queued note of this session, removed as it is read; "" when there is none.
function takeNote(input: any) {
  const session = input?.session_id ?? input?.sessionId ?? "";
  const path = typeof session === "string" && session.trim() ? notePath(session) : "";
  if (!path || !existsSync(path)) return "";
  const note = readFileSync(path, "utf8");
  rmSync(path, { force: true });
  return note;
}

// Exit 1 on a broken input: a non-blocking error for UserPromptSubmit, the prompt goes on.
export function agentNotes(_args: Args) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const note = takeNote(input);
    const event = input.hook_event_name ?? input.hookEventName ?? "UserPromptSubmit";
    console.log(JSON.stringify(note ? { hookSpecificOutput: { hookEventName: event, additionalContext: note } } : {}));
  } catch (error) {
    console.log(JSON.stringify({ systemMessage: `code-quality agent-notes failed: ${(error as Error).message}` }));
    process.exit(1);
  }
}
