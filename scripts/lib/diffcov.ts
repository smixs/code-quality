// Coverage of executable lines added by the change. LCOV decides which added lines are executable.
import type { Opts } from "./config.ts";
import { parseLcov, type Tests } from "./crap.ts";
import type { Changes } from "./diff.ts";
import { isProjectSource } from "./tamper.ts";
import { type Finding, notedCheck } from "./util.ts";

type AddedLine = { file: string; line: number; hits: number };
type Policy = { lowCoverage: boolean; missingFiles: boolean };

export function diffCoverageCheck(o: Opts, ch: Changes, tests: Tests, policy: Policy) {
  const sources = [...ch].filter(([file, diff]) => isProjectSource(o, file) && !diff.deleted).map(([file]) => file);
  if (!tests.used) return noFreshCoverage(sources.length);
  const coverage = parseLcov(tests.lcov, o.repo);
  const missing = sources.filter((file) => !coverage.has(file));
  const lines = executableAdded(o, ch, coverage);
  return coverageResult(o, lines, missing, policy);
}

function noFreshCoverage(sources: number) {
  const notices = ["cov/diff: not run, no fresh lcov", `cov/diff: changed source files without lcov data: ${sources}`];
  return notedCheck("cov/diff", [], notices[0], notices);
}

function coverageResult(o: Opts, lines: AddedLine[], missing: string[], policy: Policy) {
  const covered = lines.filter((x) => x.hits > 0).length;
  const ratio = lines.length ? covered / lines.length : 1;
  const summary = coverageSummary(covered, lines.length, o.toml.thresholds.diff_coverage);
  const findings = missingFindings(missing, policy.missingFiles);
  const notices = missingNotices(missing, policy.missingFiles);
  if (ratio >= o.toml.thresholds.diff_coverage) return notedCheck("cov/diff", findings, summary, notices);
  const missed = lines.filter((x) => x.hits === 0).slice(0, 20);
  const detail = `${summary}; uncovered ${missed.map((x) => `${x.file}:${x.line}`).join(", ")}`;
  if (policy.lowCoverage) findings.push({ rule: "cov/diff", file: missed[0]?.file ?? ".", line: missed[0]?.line ?? 0, msg: detail });
  else notices.push(`note: cov/diff ${detail}`);
  return notedCheck("cov/diff", findings, summary, notices);
}

function missingFindings(files: string[], block: boolean): Finding[] {
  return block && files.length ? [{ rule: "cov/diff", file: files[0], line: 0, msg: `${files.length} changed source file(s) without lcov data; run tests with coverage first` }] : [];
}

const missingNotices = (files: string[], block: boolean) => files.length > 0 && !block ? [`cov/diff: changed source files without lcov data: ${files.length}`] : [];

function executableAdded(o: Opts, ch: Changes, coverage: Map<string, Map<number, number>>) {
  const out: AddedLine[] = [];
  for (const [file, d] of ch) {
    if (!isProjectSource(o, file)) continue;
    const hits = coverage.get(file);
    if (!hits) continue;
    for (const line of d.added.keys()) if (hits.has(line)) out.push({ file, line, hits: hits.get(line)! });
  }
  return out;
}

function coverageSummary(covered: number, total: number, threshold: number) {
  const ratio = total ? covered / total : 1;
  return `cov/diff: ${(ratio * 100).toFixed(1)}% (${covered}/${total} executable added lines, minimum ${(threshold * 100).toFixed(0)}%)`;
}
