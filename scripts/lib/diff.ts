// What changed, per scope: base (merge-base + working tree + untracked), staged, since <rev>, all.
// touched = lines to judge functions by (a pure deletion touches its neighbours);
// added = the text of added lines (for grep-style checks). WHOLE = the entire file counts.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "./config.ts";
import { emptyTree, git, gitPaths, lines } from "./util.ts";

export const WHOLE = -1;
const MAX_BYTES = 2_000_000;

export type DiffHunk = {
  oldStart: number;
  newStart: number;
  added: Map<number, string>;
  removed: Map<number, string>;
};
export type FileDiff = {
  touched: Set<number>;
  added: Map<number, string>;
  removed: Map<number, string>;
  hunks: DiffHunk[];
  deleted: boolean;
};
export type Changes = Map<string, FileDiff>;

export function diffArgs(o: Opts, files?: string[]): string[] {
  const pathspec = files ? ["--", ...files] : [];
  const s = o.scope;
  const diff = ["-c", "core.quotePath=false", "diff"];
  if (s.kind === "staged") return [...diff, "--cached", "-U0", "--relative", "--no-color", "--no-ext-diff", headOrEmpty(o.repo), ...pathspec];
  if (s.kind === "since") return [...diff, "-U0", "--relative", "--no-color", "--no-ext-diff", s.rev, "HEAD", ...pathspec];
  const mb = git(o.repo, "merge-base", o.base, "HEAD").trim();
  return [...diff, "-U0", "--relative", "--no-color", "--no-ext-diff", mb, ...pathspec];
}

export function headOrEmpty(repo: string) {
  try {
    return git(repo, "rev-parse", "--verify", "-q", "HEAD").trim();
  } catch {
    return emptyTree(repo);
  }
}

const fresh = (): FileDiff => ({ touched: new Set(), added: new Map(), removed: new Map(), hunks: [], deleted: false });

function entry(m: Changes, file: string) {
  if (!m.has(file)) m.set(file, fresh());
  return m.get(file)!;
}

// Parse `git diff -U0`: `+++ b/file`, `@@ -a,b +c,d @@`, then `+` lines numbered from c.
export function parseDiff(text: string, m: Changes = new Map()) {
  const st: ParseState = { cur: null, hunk: null, oldFile: "", oldLine: 0, newLine: 0 };
  for (const l of text.split("\n")) diffLine(m, st, l);
  return m;
}

type ParseState = {
  cur: FileDiff | null;
  hunk: DiffHunk | null;
  oldFile: string;
  oldLine: number;
  newLine: number;
};

function diffLine(m: Changes, st: ParseState, l: string) {
  if (l.startsWith("diff --git ")) resetFile(st);
  else if (l.startsWith("--- ")) st.oldFile = l.startsWith("--- a/") ? l.slice(6) : "";
  else if (l.startsWith("+++ ")) openFile(m, st, l);
  else if (st.cur) bodyLine(st, l);
}

function resetFile(st: ParseState) {
  st.cur = null;
  st.hunk = null;
  st.oldFile = "";
}

function openFile(m: Changes, st: ParseState, l: string) {
  const file = l.startsWith("+++ b/") ? l.slice(6) : l === "+++ /dev/null" ? st.oldFile : "";
  if (!file) throw new Error(`unparsed git diff path: ${l}`);
  st.cur = entry(m, file);
  st.hunk = null;
  if (st.cur && l === "+++ /dev/null") st.cur.deleted = true;
}

function bodyLine(st: ParseState, l: string) {
  if (l.startsWith("@@")) return openHunk(st, l);
  if (!st.hunk) return;
  if (l.startsWith("+")) return addLine(st, l.slice(1));
  if (l.startsWith("-")) return removeLine(st, l.slice(1));
  if (l.startsWith(" ")) {
    st.oldLine++;
    st.newLine++;
  }
}

function openHunk(st: ParseState, l: string) {
  const hit = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  if (!hit || !st.cur) return;
  st.oldLine = Number(hit[1]);
  st.newLine = Number(hit[3]);
  st.hunk = { oldStart: st.oldLine, newStart: st.newLine, added: new Map(), removed: new Map() };
  st.cur.hunks.push(st.hunk);
  if (hit[4] === "0") [st.newLine, st.newLine + 1].forEach((x) => st.cur!.touched.add(x));
}

function addLine(st: ParseState, text: string) {
  st.cur!.touched.add(st.newLine);
  st.cur!.added.set(st.newLine, text);
  st.hunk!.added.set(st.newLine, text);
  st.newLine++;
}

function removeLine(st: ParseState, text: string) {
  st.cur!.removed.set(st.oldLine, text);
  st.hunk!.removed.set(st.oldLine, text);
  st.oldLine++;
}

// The whole file counts as changed: untracked files and --all.
function wholeFile(m: Changes, repo: string, file: string) {
  const path = join(repo, file);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > MAX_BYTES) return;
  const d = entry(m, file);
  d.touched.add(WHOLE);
  const h: DiffHunk = { oldStart: 0, newStart: 1, added: new Map(), removed: new Map() };
  readFileSync(path, "utf8").split("\n").forEach((t, i) => {
    d.added.set(i + 1, t);
    h.added.set(i + 1, t);
  });
  d.hunks.push(h);
}

export function changes(o: Opts): Changes {
  if (o.scope.kind === "all") return allFiles(o.repo);
  const m = parseDiff(git(o.repo, ...diffArgs(o, ["."])));
  if (o.scope.kind === "base") for (const f of lines(gitPaths(o.repo, "ls-files", "--others", "--exclude-standard"))) wholeFile(m, o.repo, f);
  return m;
}

function allFiles(repo: string) {
  const m: Changes = new Map();
  for (const f of lines(gitPaths(repo, "ls-files"))) wholeFile(m, repo, f);
  return m;
}

export function isTouched(d: FileDiff | undefined, from: number, to: number) {
  if (!d) return false;
  if (d.touched.has(WHOLE)) return true;
  for (let l = from; l <= to; l++) if (d.touched.has(l)) return true;
  return false;
}

export function addedLines(m: Changes, pick: (file: string) => boolean) {
  const out: { file: string; line: number; text: string }[] = [];
  for (const [file, d] of m) if (pick(file)) d.added.forEach((text, line) => out.push({ file, line, text }));
  return out;
}
