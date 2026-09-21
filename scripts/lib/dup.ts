// jscpd on changed source files only; a clone counts when one of its sides overlaps changed lines.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { Opts } from "./config.ts";
import { type Changes, isTouched } from "./diff.ts";
import { check, type Finding, notedCheck, run } from "./util.ts";

export const JSCPD = "jscpd@5.2.1";

type Side = { name: string; start: number; end: number };

// --absolute: without it jscpd names files relative to the common folder of each input group.
function sideOf(x: any, repo: string): Side {
  return { name: relative(realpathSync(repo), realpathSync(x.name)), start: x.start, end: x.end };
}

function toFinding(d: any, ch: Changes, repo: string): Finding | null {
  const [a, b] = [sideOf(d.firstFile, repo), sideOf(d.secondFile, repo)];
  const hit = [a, b].find((s) => isTouched(ch.get(s.name), s.start, s.end));
  if (!hit) return null;
  const other = hit === a ? b : a;
  return { rule: "dup/jscpd", file: hit.name, line: hit.start, msg: `${d.lines} duplicated lines with ${other.name}:${other.start}-${other.end}` };
}

export function dupCheck(o: Opts, ch: Changes, files: string[]) {
  const todo = files.filter((f) => ch.has(f));
  if (!todo.length) return check("dup", []);
  const dir = join(o.out, "jscpd");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = ["-y", JSCPD, "--absolute", "--reporters", "json", "--output", dir, "--min-tokens", String(o.toml.thresholds.dup_min_tokens), ...todo];
  const r = run("npx", args, o.repo, { timeout: 300_000 });
  if (r.code === -1) return notedCheck("dup", [], "", ["dup/jscpd: not run (npx not found; install Node.js, then npm install -g jscpd@5.2.1)"]);
  const report = join(dir, "jscpd-report.json");
  if (!existsSync(report)) return check("dup", [], `jscpd failed (exit ${r.code}): ${(r.err || r.out).slice(0, 300)}`);
  const dups: any[] = JSON.parse(readFileSync(report, "utf8")).duplicates ?? [];
  return check("dup", dups.map((d) => toFinding(d, ch, o.repo)).filter((x): x is Finding => x !== null));
}
