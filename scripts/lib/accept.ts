// check --since <rev> --tests: the acceptance verdict on a change. The change's touched tests run with
// coverage into a private <out_dir>/touched/run-*/ directory, and the change is judged with that
// coverage in the same process; the full lcov and its meta are never touched.
import { existsSync, readFileSync } from "node:fs";
import type { Opts } from "./config.ts";
import { runTouchedCoverage, type Tests } from "./crap.ts";
import { changes } from "./diff.ts";
import { isDocsOnly } from "./gate.ts";
import { touchedCoverageCommand } from "./lang.ts";
import { commitMessages, isProjectSource } from "./tamper.ts";
import type { RunResult } from "./testrun.ts";
import { ACCEPTANCE, noTestCheck, touchedTestSelection } from "./touched.ts";
import { type Check, check } from "./util.ts";

// dir = the private run directory ("" = no run); failed = keep it for the lead.
export type Lane = { tests: Tests; lines: string[]; checks: Check[]; dir: string; failed: boolean };

const NOT_RUN: Tests = { scope: "touched", lcov: "", code: 0, failed: null, skipped: true, red: false, used: false };
const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// null = a docs-only change: the plain check path judges it, no test runs, no lcov is written.
export async function acceptanceTests(o: Opts): Promise<Lane | null> {
  const ch = changes(o);
  if (isDocsOnly(o, ch)) return null;
  const files = [...ch.keys()];
  const selection = touchedTestSelection(o, files, ACCEPTANCE);
  const counts = `touched tests: ${selection.byName} by name, ${selection.byImport} by direct import, ${selection.bySecondHop} by second-hop import`;
  // qg:no-test in the commit messages of <rev>..HEAD: no tests run, complexity only, cov/diff not run.
  const noTest = noTestCheck(files.some((file) => isProjectSource(o, file)), selection.tests.length, commitMessages(o));
  if (!selection.tests.length) return { tests: NOT_RUN, lines: [counts, "tests: not run, no touched tests"], checks: [noTest], dir: "", failed: false };
  const command = touchedCoverageCommand({ repo: o.repo, lang: o.lang, readPackage: readText, tests: o.toml.tests, testCmd: o.testCmd });
  const { run, tests, dir } = await runTouchedCoverage(o, selection.tests, command.cmd);
  const verdict = runVerdict(o, run, tests, selection.tests.length);
  const notices = [`note: tests/touched command: ${command.cmd}`, ...command.notes];
  const failed = verdict.check.findings.length > 0 || verdict.check.error !== "";
  return { tests, lines: [counts, verdict.line], checks: [noTest, { ...verdict.check, notices }], dir, failed };
}

// Timeout, then red, then exit 0 without coverage.
function runVerdict(o: Opts, r: RunResult, t: Tests, count: number) {
  const files = `${count} touched test file(s)`;
  if (r.timedOut) {
    const msg = `tests/timeout after ${o.toml.tests.touched_timeout_s}s, process group killed; log ${r.log}`;
    return { line: `tests: ${files} ${msg}`, check: check("tests", [finding("tests/timeout", msg)]) };
  }
  if (r.code !== 0) {
    const failed = t.failed !== null ? `${t.failed} failed, exit ${r.code}` : `exit ${r.code}`;
    return { line: `tests: ${files} red (${failed}) in ${r.secs}s, log ${r.log}`, check: check("tests", [finding("tests/red", `${failed}; log ${r.log}`)]) };
  }
  // The verdict prints the check error as `tests: ERROR invalid coverage at <path>, see <log>`.
  if (!t.used) return { line: `tests: ${files} exit 0 in ${r.secs}s, no valid coverage`, check: check("tests", [], `invalid coverage at ${t.lcov}, see ${r.log}`) };
  return { line: `tests: ${files} pass in ${r.secs}s, coverage fresh (touched)`, check: check("tests", []) };
}

const finding = (rule: string, msg: string) => ({ rule, file: ".", line: 0, msg });
