#!/usr/bin/env bun
// code-quality: one bar for every repo. CRAP per function (A-exact-2), deps, dead code, eslint form,
// duplication, ast-grep rules, doc links, glossary, secrets. Config: <repo>/.quality.toml.
//
//   quality.ts [flags]                    full gate: tests with coverage + every check (minutes)
//   quality.ts check [--staged|--since R|--all]   deterministic gate on the change (seconds)
//   quality.ts hook pre-commit|commit-msg <file>|pre-push   called by git-hooks/*
//   quality.ts install-hooks <repo> | uninstall-hooks <repo>
//   quality.ts agent-stop                 Stop hook contract (stdin JSON -> stdout JSON)
import { type Args, buildOpts, readArgs, repoConfigFile } from "./lib/config.ts";
import type { Coverage } from "./lib/crap.ts";
import { analyze, gate, writeBaseline } from "./lib/gate.ts";
import { agentStop, installHooks, runCheck, runHook, uninstallHooks, updatePluginRoot } from "./lib/hooks.ts";
import { guardBash } from "./lib/guard-bash.ts";
import { checkNotices, churn, failCount, testsLine, verdictText, worklist, writeReport } from "./lib/report.ts";
import { riskCrap } from "./lib/crap.ts";

function full(args: Args) {
  const o = buildOpts({ ...args, values: { ...args.values, all: true } });
  const mode: Coverage = o.flags["skip-tests"] ? "reuse" : "run";
  const a = analyze(o, mode);
  const g = gate(o, a);
  const blocked = o.flags["update-baseline"] ? writeBaseline(o, a) : [];
  const report = writeReport(o, a, g, "report.md");
  console.log(worklist(a.fns, churn(o.repo)).map((w) => `${w.action.padEnd(11)} ${riskCrap(w.f).toFixed(1).padStart(7)}  ${w.f.file}:${w.f.start} ${w.f.name}`).join("\n"));
  console.log(`\n${testsLine(a.tests)}`);
  if (o.flags["update-baseline"]) return finishBaseline(o.baseline, blocked, report);
  console.log(verdictText(g.checks, a, o.flags["allow-red-tests"]));
  for (const notice of checkNotices(g.checks)) console.log(notice);
  for (const note of g.drift.filter((line) => line.startsWith("note: "))) console.log(note);
  console.log(`report: ${report}`);
  process.exit(failCount(g.checks) ? 1 : 0);
}

function finishBaseline(path: string, blocked: string[], report: string) {
  console.log(blocked.length ? blocked.join("\n") : `baseline written: ${path}`);
  console.log(`report: ${report}`);
  process.exit(blocked.length ? 1 : 0);
}

async function checkCmd(args: Args) {
  const repo = args.values.repo ?? process.cwd();
  if (args.values["if-configured"] && !repoConfigFile(repo)) return;
  const r = await runCheck(buildOpts(args));
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}

const COMMANDS: Record<string, (a: Args) => void | Promise<void>> = {
  check: checkCmd,
  hook: runHook,
  "agent-stop": agentStop,
  "guard-bash": guardBash,
  "install-hooks": (a) => installHooks(a.positionals[1]),
  "uninstall-hooks": (a) => uninstallHooks(a.positionals[1]),
};

async function main() {
  updatePluginRoot();
  const args = readArgs();
  const cmd = args.positionals[0];
  if (!cmd) return full(args);
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`unknown command ${cmd}; expected ${Object.keys(COMMANDS).join(" | ")} or no command for the full gate`);
  await fn(args);
}

// CLI boundary: a broken config or a failed tool is an error with its cause, exit 2 (not a red gate).
try {
  await main();
} catch (e) {
  console.error(`code-quality: ${(e as Error).message}`);
  process.exit(2);
}
