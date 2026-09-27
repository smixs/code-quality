// mutant: one exact mutation, the touched tests, a guaranteed restore, the verdict in the exit code
// (0 killed, 1 survived, 2 error, 130/143 interrupted). The selected tests first run on the original
// bytes; KILLED needs a parsed count of failing tests. State in <out_dir>/mutant/lock/: <name>.orig and
// owner.json, so a run killed with SIGKILL is restored by the next one.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { type Args, buildOpts, type Opts } from "./config.ts";
import { parseTestSummary } from "./crap.ts";
import { isTestFile, mutantTestCommand, type Runner, testRunner } from "./lang.ts";
import { waitForLoad } from "./load.ts";
import { type RunResult, startTestRun, type TestRun } from "./testrun.ts";
import { ACCEPTANCE, touchedTestSelection } from "./touched.ts";
import { run, shq } from "./util.ts";

export type MutantInput = { file?: string; find?: string; replace?: string; tests: string[] };
export type Outcome = { code: 0 | 1 | 2 | 130 | 143; line: string; failing: number | null };
// The writes to the target file; the restore-failure test injects a failing one.
export type MutantFs = { writeFile: (path: string, bytes: Buffer) => void };

type Owner = { pid: number; started_at: string; repo: string; file: string; original_sha256: string; mutant_sha256: string };
type State = { dir: string; lock: string; owner: string; orig: (file: string) => string };
type Target = { abs: string; rel: string; original: Buffer; mutant: Buffer };
type Plan = { target: Target; tests: string[]; cmd: string; runners: Runner[]; porcelain: string; input: MutantInput };
type Signal = { name: NodeJS.Signals; code: 130 | 143 } | null;
// keep = the target drifted before the mutant write: target and state stay as they are.
type Step = Outcome & { keep?: boolean };

class MutantError extends Error {}

const realFs: MutantFs = { writeFile: (path, bytes) => writeFileSync(path, bytes) };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const error = (why: string): Outcome => ({ code: 2, line: `MUTANT ERROR: ${why}`, failing: null });

function stateOf(o: Opts): State {
  const dir = join(o.out, "mutant");
  const lock = join(dir, "lock");
  return { dir, lock, owner: join(lock, "owner.json"), orig: (file) => join(lock, `${basename(file)}.orig`) };
}

export async function mutantCmd(args: Args) {
  const o = buildOpts(args);
  const v = args.values;
  const outcome = await runMutant(o, { file: v.file, find: v.find, replace: v.replace, tests: v.test ?? [] });
  console.log(outcome.line);
  process.exit(outcome.code);
}

// The orchestrator. Validation, leftover recovery and preparation end in MUTANT ERROR before any lock
// or run; after the lock every path goes through finish().
export async function runMutant(o: Opts, input: MutantInput, fs: MutantFs = realFs): Promise<Outcome> {
  try {
    validateArgs(input);
    const state = stateOf(o);
    recoverLeftover(o, state, fs);
    const plan = prepare(o, input);
    waitForLoad(o);
    lock(o, state, plan.target);
    return await locked(o, state, plan, fs);
  } catch (e) {
    if (e instanceof MutantError) return error(e.message);
    throw e;
  }
}

// ---- arguments, target, tests

function validateArgs(input: MutantInput) {
  if (!input.file || input.find === undefined || input.replace === undefined) throw new MutantError("usage: mutant --repo <r> --file <path> --find <exact text> --replace <text> [--test <path>]...");
  if (!input.find) throw new MutantError("--find is empty");
  if (input.find === input.replace) throw new MutantError("--find and --replace are the same text");
  if ([input.file, input.find, input.replace, ...input.tests].some((arg) => arg.includes("\0"))) throw new MutantError("an argument contains a NUL byte");
}

function prepare(o: Opts, input: MutantInput): Plan {
  const target = readTarget(o, input);
  const commands = { repo: o.repo, lang: o.lang, readPackage: readText, tests: o.toml.tests, testCmd: o.testCmd };
  const cmd = mutantTestCommand(commands);
  if (!cmd) throw new MutantError(`no file-aware test command for ${o.lang}; set [tests] mutant_cmd`);
  const runners = summaryRunners(testRunner(o.repo, o.lang, readText), Boolean(o.toml.tests.mutant_cmd));
  const tests = input.tests.length ? explicitTests(o, input.tests) : touchedTestSelection(o, [target.rel], ACCEPTANCE).tests;
  if (!tests.length) throw new MutantError(`no test selected for ${target.rel}; pass --test <path>`);
  return { target, tests, cmd, runners, porcelain: gitStatus(o, target.rel), input };
}

// The adapter's command prints its runner's summary; a custom mutant_cmd may print any known one.
const RUNNERS: Runner[] = ["node", "bun", "vitest", "py"];
function summaryRunners(detected: Runner | null, custom: boolean) {
  if (!custom) return detected ? [detected] : [];
  return detected ? [detected, ...RUNNERS.filter((runner) => runner !== detected)] : RUNNERS;
}

function summary(plan: Plan, log: string) {
  const all = plan.runners.map((runner) => parseTestSummary(runner, log));
  return all.find((counts) => !("error" in counts)) ?? { error: "no node, bun, vitest or pytest test summary in the log" };
}

// A regular UTF-8 text file, not a symlink, inside the repo, without staged changes, with the find
// text exactly once.
function readTarget(o: Opts, input: MutantInput): Target {
  const abs = resolve(o.repo, input.file!);
  const rel = regularInRepo(o, abs, input.file!);
  const original = readFileSync(abs);
  if (!utf8(original)) throw new MutantError(`not a UTF-8 text file: ${rel}`);
  if (run("git", ["diff", "--cached", "--quiet", "--", rel], o.repo).code !== 0) throw new MutantError(`${rel} has staged changes; mutant guarantees the worktree bytes only`);
  const find = Buffer.from(input.find!);
  const count = occurrences(original, find);
  if (count !== 1) throw new MutantError(`find text occurs ${count} times in ${rel}, expected exactly 1`);
  const at = original.indexOf(find);
  const mutant = Buffer.concat([original.subarray(0, at), Buffer.from(input.replace!), original.subarray(at + find.length)]);
  return { abs, rel, original, mutant };
}

// The repo-relative path of an existing regular non-symlink file whose realpath is inside the repo.
function regularInRepo(o: Opts, abs: string, shown: string) {
  if (!existsSync(abs)) throw new MutantError(`file not found: ${shown}`);
  const stat = lstatSync(abs);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new MutantError(`not a regular file: ${shown}`);
  const rel = relative(realpathSync(o.repo), realpathSync(abs));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new MutantError(`file is outside the repo: ${shown}`);
  return rel;
}

function utf8(bytes: Buffer) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !bytes.includes(0);
  } catch {
    return false;
  }
}

function occurrences(text: Buffer, find: Buffer) {
  let count = 0;
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) count++;
  return count;
}

// --test replaces the selection: normalized repo-relative paths of regular test files.
function explicitTests(o: Opts, given: string[]) {
  for (const test of given) {
    if (isAbsolute(test) || normalize(test) !== test || test.startsWith("..")) throw new MutantError(`--test must be a normalized repo-relative path: ${test}`);
    regularInRepo(o, join(o.repo, test), test);
    if (!isTestFile(o.langs, test)) throw new MutantError(`--test ${test} does not match the test file pattern of ${o.lang}`);
  }
  return given;
}

const gitStatus = (o: Opts, file: string) => run("git", ["status", "--porcelain", "--", file], o.repo).out;

// ---- state: lock/, then .orig, then owner.json (each tmp then rename), and only then the mutant

function readOwner(state: State): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(state.owner, "utf8")) as Owner;
    return typeof owner.pid === "number" && owner.file && owner.original_sha256 && owner.mutant_sha256 ? owner : null;
  } catch {
    return null;
  }
}

// A lock whose pid is alive is live at any age; only a dead pid's state is recovered.
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function recoverLeftover(o: Opts, state: State, fs: MutantFs) {
  if (!existsSync(state.lock)) return;
  const owner = readOwner(state);
  if (!owner) throw new MutantError(`mutant state without a readable owner, kept: ${state.lock}; inspect it and remove it`);
  if (alive(owner.pid)) throw new MutantError(`another mutant is running (pid ${owner.pid})`);
  const abs = leftoverTarget(o, state, owner);
  const orig = state.orig(owner.file);
  const current = regularSha(abs);
  if (current === owner.original_sha256) {
    removeState(state);
    console.log(`removed stale mutant state of ${owner.file}`);
    return;
  }
  if (current !== owner.mutant_sha256) throw new MutantError(`target changed after the mutant process died; original kept at ${orig}`);
  const bytes = existsSync(orig) ? readFileSync(orig) : Buffer.alloc(0);
  if (sha256(bytes) !== owner.original_sha256 || !restoreBytes(abs, bytes, fs)) throw new MutantError(`restore failed, original at ${orig}`);
  removeState(state);
  console.log(`restored leftover mutant of ${owner.file}`);
}

// owner.json is data on disk: it must name this repo and a normalized path inside it, and the target
// must pass the check made before a mutant write. Anything else writes nothing and keeps the state.
function leftoverTarget(o: Opts, state: State, owner: Owner) {
  const kept = `; state kept at ${state.lock}`;
  if (realOrEmpty(String(owner.repo)) !== realOrEmpty(o.repo)) throw new MutantError(`leftover mutant state names another repo (${owner.repo})${kept}`);
  if (isAbsolute(owner.file) || normalize(owner.file) !== owner.file || owner.file.startsWith("..")) throw new MutantError(`leftover mutant state names a path outside the repo (${owner.file})${kept}`);
  const abs = resolve(o.repo, owner.file);
  if (!existsSync(abs)) return abs;
  try {
    regularInRepo(o, abs, owner.file);
  } catch (e) {
    throw new MutantError(`${(e as Error).message}${kept}`);
  }
  return abs;
}

function realOrEmpty(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

// sha256 of a regular non-symlink file; "" for anything else.
function regularSha(abs: string) {
  try {
    const stat = lstatSync(abs);
    return stat.isFile() && !stat.isSymbolicLink() ? sha256(readFileSync(abs)) : "";
  } catch {
    return "";
  }
}

function lock(o: Opts, state: State, target: Target) {
  mkdirSync(state.dir, { recursive: true });
  try {
    mkdirSync(state.lock);
  } catch {
    throw new MutantError(`another mutant is running (pid ${readOwner(state)?.pid ?? "unknown"})`);
  }
  try {
    const owner: Owner = { pid: process.pid, started_at: new Date().toISOString(), repo: o.repo, file: target.rel, original_sha256: sha256(target.original), mutant_sha256: sha256(target.mutant) };
    writeRenamed(state.orig(target.rel), target.original);
    writeRenamed(state.owner, Buffer.from(JSON.stringify(owner)));
  } catch (e) {
    rmSync(state.lock, { recursive: true, force: true });
    throw new MutantError(`cannot write the mutant state in ${state.lock}: ${(e as Error).message}`);
  }
}

function writeRenamed(path: string, bytes: Buffer) {
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

function restoreBytes(abs: string, original: Buffer, fs: MutantFs) {
  try {
    fs.writeFile(abs, original);
    return regularSha(abs) === sha256(original);
  } catch {
    return false;
  }
}

// owner.json, then .orig, then lock/ last; the empty mutant/ directory goes too.
function removeState(state: State) {
  const files = existsSync(state.lock) ? readdirSync(state.lock).map((name) => join(state.lock, name)) : [];
  const ordered = [...files.filter((path) => path === state.owner), ...files.filter((path) => path !== state.owner)];
  for (const path of [...ordered, state.lock]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      throw new MutantError(`cannot remove mutant state ${path}`);
    }
  }
  try {
    rmdirSync(state.dir);
  } catch {
    // not empty or already gone: another run's files, never ours
  }
}

// ---- the run, with the lock held

async function locked(o: Opts, state: State, plan: Plan, fs: MutantFs): Promise<Outcome> {
  let signal: Signal = null;
  let child: TestRun | null = null;
  const on = (name: NodeJS.Signals, code: 130 | 143) => () => {
    signal ??= { name, code };
    void child?.kill();
  };
  const onInt = on("SIGINT", 130);
  const onTerm = on("SIGTERM", 143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const runTests = (log: string) => {
    child = startTestRun(o, { cmd: plan.cmd.replaceAll("{files}", plan.tests.map(shq).join(" ")), log: join(o.out, log), timeoutS: Number(o.toml.tests.mutant_timeout_s), signals: "caller", loadWait: false });
    return child.done;
  };
  try {
    const outcome = await mutantRun(o, plan, fs, runTests, () => signal);
    return finish(o, state, plan, fs, outcome, () => signal);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

// Preflight on the original bytes, then the target checks, then the mutant and its run.
async function mutantRun(o: Opts, plan: Plan, fs: MutantFs, runTests: (log: string) => Promise<RunResult>, signal: () => Signal): Promise<Step> {
  try {
    const pre = await runTests("mutant-preflight.log");
    if (signal()) return error("interrupted");
    const bad = preflightProblem(o, plan, pre);
    if (bad) return error(`original tests: ${bad}; log ${pre.log}`);
    const drift = targetDrift(o, plan.target);
    if (drift) return { ...error(drift), keep: true };
    fs.writeFile(plan.target.abs, plan.target.mutant);
    if (signal()) return error("interrupted");
    return verdict(o, plan, await runTests("mutant-run.log"));
  } catch (e) {
    return error((e as Error).message);
  }
}

// Right before the mutant write: realpath inside the repo, a regular non-symlink file, the original sha.
function targetDrift(o: Opts, target: Target) {
  try {
    if (regularInRepo(o, target.abs, target.rel) !== target.rel) return `${target.rel} moved during the preflight; target and state kept`;
  } catch (e) {
    return `${(e as Error).message}; target and state kept`;
  }
  return regularSha(target.abs) === sha256(target.original) ? "" : `${target.rel} changed during the preflight; target and state kept`;
}

// Right before the restore: still a regular non-symlink file whose realpath is inside the repo.
function restoreDrift(o: Opts, target: Target) {
  try {
    return regularInRepo(o, target.abs, target.rel) === target.rel ? "" : `${target.rel} moved during the run`;
  } catch (e) {
    return (e as Error).message;
  }
}

function preflightProblem(o: Opts, plan: Plan, r: RunResult) {
  if (r.timedOut) return `timed out after ${o.toml.tests.mutant_timeout_s}s`;
  const counts = summary(plan, readText(r.log));
  if ("error" in counts) return `cannot be read: ${counts.error}`;
  if (r.code !== 0 || counts.failed) return `fail on the original bytes (exit ${r.code}, ${counts.failed} failed)`;
  return counts.ran ? "" : "no test ran";
}

function verdict(o: Opts, plan: Plan, r: RunResult): Outcome {
  const files = plan.tests.join(" ");
  if (r.timedOut) return error(`the mutated run timed out after ${o.toml.tests.mutant_timeout_s}s; log ${r.log}`);
  const counts = summary(plan, readText(r.log));
  if ("error" in counts) return error(`cannot read test counts (${counts.error}); log ${r.log}`);
  if (counts.failed > 0) return { code: 0, line: `MUTANT KILLED: ${counts.failed} failing test(s) in ${files}`, failing: counts.failed };
  if (r.code === 0 && counts.ran > 0) return { code: 1, line: `MUTANT SURVIVED: ${files} passed with the mutant`, failing: 0 };
  if (!counts.ran) return error(`no test ran in ${files}; log ${r.log}`);
  return error(`tests exited ${r.code} without a failing test; log ${r.log}`);
}

// Restore and verify, append the JSONL record, then remove the state. A target that is neither the
// mutant nor the original, or a failed restore, keeps the target and the state and beats every outcome.
function finish(o: Opts, state: State, plan: Plan, fs: MutantFs, outcome: Step, signal: () => Signal): Outcome {
  const { target } = plan;
  const stopped = signal();
  const result = stopped && !outcome.keep ? { code: stopped.code, line: `MUTANT ERROR: interrupted by ${stopped.name}, ${target.rel} restored`, failing: null } : outcome;
  if (outcome.keep) return appendLog(o, plan, result);
  const moved = restoreDrift(o, target);
  if (moved) return appendLog(o, plan, error(`${moved}; target and state kept, original at ${state.orig(target.rel)}`));
  const current = regularSha(target.abs);
  if (current !== sha256(target.original) && current !== sha256(target.mutant)) return appendLog(o, plan, error(`${target.rel} is neither the original nor the mutant; target and state kept, original at ${state.orig(target.rel)}`));
  if (current !== sha256(target.original) && !restoreBytes(target.abs, target.original, fs)) return appendLog(o, plan, error(`restore failed, original at ${state.orig(target.rel)}`));
  const proven = gitStatus(o, target.rel) === plan.porcelain ? result : error(`restore cannot be proven: git status of ${target.rel} changed`);
  const logged = appendLog(o, plan, proven);
  try {
    removeState(state);
  } catch (e) {
    return error((e as Error).message);
  }
  return logged;
}

function appendLog(o: Opts, plan: Plan, outcome: Outcome): Outcome {
  const path = join(o.out, "mutants.log");
  const kind = outcome.code === 130 || outcome.code === 143 ? "interrupted" : outcome.line.slice("MUTANT ".length).split(":")[0].toLowerCase();
  const row = { time: new Date().toISOString(), file: plan.target.rel, find: plan.input.find, replace: plan.input.replace, tests: plan.tests, outcome: kind, failing: outcome.failing, pid: process.pid };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    return { code: outcome.code, line: outcome.line, failing: outcome.failing };
  } catch {
    return error(`cannot append ${path}`);
  }
}
