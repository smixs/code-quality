// report.md and the console verdict.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "./config.ts";
import { type Fn, riskCrap, type Tests } from "./crap.ts";
import { DEPCRUISE, type Deps, KNIP, type Knip } from "./deps.ts";
import { type Analysis, meanCrap, redText } from "./gate.ts";
import { type Check, findingLine, gitPaths, lines, run } from "./util.ts";

// CRAP never drops below cc, so above 8 only a split brings a function to CRAP <= 8.
const SPLIT_CC = 8;
const RISKY_CRAP = 8;
const RISKY_CC = 10;

const isRisky = (f: Fn) => riskCrap(f) > RISKY_CRAP || f.cc > RISKY_CC;

const headLabel = (repo: string) => run("git", ["rev-parse", "-q", "--verify", "--short", "HEAD"], repo).out.trim() || "no commits yet";

export function churn(repo: string) {
  const counts = new Map<string, number>();
  if (run("git", ["rev-parse", "-q", "--verify", "HEAD"], repo).code !== 0) return counts; // first commit: no history yet
  for (const f of lines(gitPaths(repo, "log", "--since=12.months", "--format=", "--name-only"))) counts.set(f, (counts.get(f) ?? 0) + 1);
  return counts;
}

// Score = commits x sum CRAP of risky functions only; a file of many small clean functions is no hotspot.
function hotspots(fns: Fn[], ch: Map<string, number>) {
  const byFile = Map.groupBy(fns.filter(isRisky), (f) => f.file);
  const rows = [...byFile].map(([file, list]) => hotRow(file, list, ch.get(file) ?? 0));
  return rows.sort((a, b) => b.score - a.score).slice(0, 15);
}

function hotRow(file: string, list: Fn[], commits: number) {
  const crap = list.reduce((s, f) => s + riskCrap(f), 0);
  return { file, risky: list.length, crap, commits, score: crap * commits };
}

function advice(f: Fn) {
  const uncovered = (f.cov ?? 0) < 1;
  if (f.cc <= SPLIT_CC) return uncovered ? "tests" : null;
  return uncovered ? "tests+split" : "split";
}

export function worklist(fns: Fn[], ch: Map<string, number>) {
  const risk = (f: Fn) => riskCrap(f) * Math.max(1, ch.get(f.file) ?? 0);
  const top = fns.filter((f) => riskCrap(f) > RISKY_CRAP && advice(f)).sort((a, b) => risk(b) - risk(a)).slice(0, 10);
  return top.map((f) => ({ f, risk: risk(f), action: advice(f)! }));
}

function stats(o: Opts, fns: Fn[]) {
  const c = fns.map(riskCrap).sort((a, b) => a - b);
  const over = c.filter((x) => x > o.maxCrap).length;
  return `functions ${fns.length}, without coverage data ${fns.filter((f) => f.crap === null).length}, CRAP mean ${meanCrap(fns).toFixed(3)} (warning > ${o.toml.thresholds.max_mean_crap}), median ${(c[c.length >> 1] ?? 0).toFixed(1)}, > ${o.maxCrap}: ${over}, cc > ${o.maxCc}: ${fns.filter((f) => f.cc > o.maxCc).length}`;
}

const pct = (c: number | null) => (c === null ? "no data" : `${Math.round(c * 100)}%`);

export function testsLine(t: Tests) {
  if (t.skipped && t.lastRun) return `tests: not run (last full run ${t.lastRun.written}, ${t.lastRun.commit.slice(0, 8)})`;
  if (!t.used) return "tests: not run, no fresh lcov (CRAP and mean not judged; complexity only)";
  return `tests exit ${t.code}, failed ${t.failed ?? "unknown"}`;
}

function depLines(deps: Deps | null) {
  if (!deps) return ["skipped"];
  if (deps.error) return [deps.error];
  return [`modules cruised: ${deps.modules}`, `cycles: ${deps.cycles.length}`, ...deps.cycles.map((c) => `- ${c.text}`), `layer violations: ${deps.layers.length}`, ...deps.layers.map((l) => `- ${l}`)];
}

function knipLines(k: Knip | null) {
  if (!k) return ["skipped"];
  if (k.error) return [k.error];
  const counts = Object.entries(k.counts).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(", ");
  const list = (title: string, xs: string[]) => [`### ${title} (${Math.min(50, xs.length)} of ${xs.length})`, ...xs.slice(0, 50).map((x) => `- ${x}`)];
  return [`counts: ${counts || "none"}`, ...list("Unused files", k.files), ...list("Unused exports and types", k.exports)];
}

function checkLines(c: Check) {
  const head = `### ${c.name}: ${c.error ? `ERROR ${c.error}` : `${c.findings.length} finding(s)`}${c.note ? ` (${c.note})` : ""}`;
  return [head, ...c.findings.slice(0, 200).map((f) => `- ${findingLine(f)}`), ...c.notices.map((line) => `- ${line}`)];
}

export const checkNotices = (checks: Check[]) => checks.flatMap((c) => c.notices);

export const bypassNotices = (checks: Check[]) => checkNotices(checks).filter((line) => line.startsWith("note: bypass "));

export function writeReport(o: Opts, a: Analysis, g: { checks: Check[]; drift: string[]; escalate: string[] }, name: string) {
  const ch = churn(o.repo);
  const scope = a.docsOnly ? "docs-only" : `${o.scope.kind}${o.scope.rev ? ` ${o.scope.rev}` : ""}`;
  const L = [`# Quality report ${new Date().toISOString()}`, "", `repo ${o.repo} @ ${headLabel(o.repo)}, scope ${scope}, base ${o.base}, config ${o.cfgFile || "defaults"}, baseline ${o.baseline}`, testsLine(a.tests), ""];
  const bypasses = bypassNotices(g.checks);
  L.push("## Gate", ...g.checks.flatMap(checkLines), "", "## Bypasses", ...bypasses.map((line) => `- ${line}`), "", "## Escalate to reviewer (not wired yet, note only)", ...g.escalate.map((f) => `- ${f}`), "");
  L.push("## Drift (unchanged functions worse than baseline, not gated)", ...g.drift.map((x) => `- ${x}`), "");
  L.push("## Summary (no coverage data counts as 0%)", stats(o, a.fns), `unparsed files: ${a.failed.length ? a.failed.join(", ") : "none"}`, "");
  L.push("## Worklist (CRAP x commits in 12 months)", ...worklist(a.fns, ch).map((w) => `- ${w.action}: ${w.f.file}:${w.f.start} ${w.f.name} (cc ${w.f.cc}, cov ${pct(w.f.cov)}, CRAP ${riskCrap(w.f).toFixed(1)})`), "");
  L.push(`## Hotspots (commits x sum CRAP of risky functions: CRAP > ${RISKY_CRAP} or cc > ${RISKY_CC})`, "| file | commits | risky fns | sum CRAP | score |", "|---|---|---|---|---|", ...hotspots(a.fns, ch).map((h) => `| ${h.file} | ${h.commits} | ${h.risky} | ${h.crap.toFixed(0)} | ${h.score.toFixed(0)} |`), "");
  L.push("## Top 30 CRAP", ...[...a.fns].sort((x, y) => riskCrap(y) - riskCrap(x)).slice(0, 30).map((f) => `- ${riskCrap(f).toFixed(1)} cc ${f.cc} cov ${pct(f.cov)} ${f.file}:${f.start}-${f.end} ${f.name}`), "");
  L.push(`## Dependencies (${DEPCRUISE})`, ...depLines(a.deps), "", `## Dead code (${KNIP}, full output in knip.json)`, ...knipLines(a.knip), "");
  const path = join(o.out, name);
  writeFileSync(path, L.join("\n"));
  writeFileSync(path.replace(/\.md$/, ".json"), JSON.stringify({ checks: g.checks, bypasses, escalate: g.escalate }, null, 1));
  return path;
}

export function writeHookReport(o: Opts, source: string, checks: Check[]) {
  mkdirSync(o.out, { recursive: true });
  const bypasses = bypassNotices(checks);
  const md = [`# Quality report ${new Date().toISOString()}`, "", `source ${source}`, "", "## Gate", ...checks.flatMap(checkLines), "", "## Bypasses", ...bypasses.map((line) => `- ${line}`), ""];
  const path = join(o.out, "check.md");
  writeFileSync(path, md.join("\n"));
  writeFileSync(join(o.out, "check.json"), JSON.stringify({ source, checks, bypasses }, null, 1));
  return path;
}

export function failCount(checks: Check[]) {
  return checks.reduce((n, c) => n + c.findings.length + (c.error ? 1 : 0), 0);
}

export function verdictText(checks: Check[], a: Analysis, allowRed: boolean) {
  const bad = checks.filter((c) => c.findings.length || c.error);
  const rows = bad.flatMap((c) => (c.error ? [`${c.name}: ERROR ${c.error}`] : c.findings.slice(0, 15).map(findingLine)));
  if (bad.length) return `GATE FAIL (${failCount(checks)}):\n${rows.slice(0, 40).join("\n")}`;
  if (a.tests.red && allowRed) return `GATE: checks pass, TESTS RED allowed by --allow-red-tests (${redText(a.tests)})`;
  return "GATE PASS";
}
