// What every Jev question reads: diff hunks with 3 lines of context (a new file is one added hunk),
// the shared state budget, and the request/verdict shapes. No question lives here.
import type { Opts } from "./config.ts";
import { type Changes, diffArgs, WHOLE } from "./diff.ts";
import { git } from "./util.ts";

// A conservative approximation of Jev's 32k-token state limit. This budget is shared by
// all text fields in one state, so adding questions cannot multiply the state size.
export const MAX_STATE_CHARS = 40000;
export const CHARS_PER_TOKEN = MAX_STATE_CHARS / 32000;

export type Hunk = { file: string; at: string; text: string };
export type Review = Record<string, unknown>;
type Noul = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
// below: a note when p < threshold (the good answer is "yes"); otherwise when p >= threshold.
export type QBase = { id: string; label: string; below: boolean; fields: string[]; threshold: string; q: Noul };
// at: the line a question points to, when it is not the hunk's first line; suffix: said with the verdict.
export type Req = { hunk: Hunk; qs: QBase[]; body: unknown; at?: Record<string, string>; suffix?: string };

export const bodyOf = (model: string, qs: QBase[], state: object) => ({ model, state, questions: Object.fromEntries(qs.map((q) => [q.id, q.q])) });

type St = { file: string; cur: Hunk | null };

function splitHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  const st: St = { file: "", cur: null };
  for (const l of diff.split("\n")) hunkLine(out, st, l);
  return out.filter((h) => h.text.split("\n").some((l) => l.startsWith("+")));
}

function hunkLine(out: Hunk[], st: St, l: string) {
  if (l.startsWith("diff --git ")) return void (st.cur = null);
  if (l.startsWith("@@")) return void (st.cur = openHunk(out, st.file, l));
  if (st.cur) return bodyLine(st.cur, l);
  if (l.startsWith("+++ ")) st.file = fileOf(l);
}

const fileOf = (l: string) => (l.startsWith("+++ b/") ? l.slice(6) : "");

function openHunk(out: Hunk[], file: string, header: string) {
  if (!file) return null;
  const h = { file, at: `+${/\+(\d+)/.exec(header)?.[1] ?? "?"}`, text: header };
  out.push(h);
  return h;
}

function bodyLine(h: Hunk, l: string) {
  if (/^[ +\-\\]/.test(l)) h.text += `\n${l}`;
}

// Untracked and --all files have no diff: the whole file is one added hunk.
function wholeHunk(ch: Changes, file: string): Hunk {
  const body = [...ch.get(file)!.added.values()].map((t) => `+${t}`).join("\n");
  return { file, at: "+1", text: `@@ new file @@\n${body}` };
}

const isWhole = (ch: Changes, file: string) => Boolean(ch.get(file)?.touched.has(WHOLE));

// The raw `git diff -U3` of tracked files; --all has no diff.
function contextDiff(o: Opts, files: string[]) {
  if (!files.length || o.scope.kind === "all") return "";
  const args = diffArgs(o).map((a) => (a === "-U0" ? "-U3" : a));
  return git(o.repo, ...args, "--", ...files);
}

export function hunksOf(o: Opts, ch: Changes, files: string[]): Hunk[] {
  const whole = files.filter((f) => isWhole(ch, f));
  const tracked = files.filter((f) => !whole.includes(f));
  return [...splitHunks(contextDiff(o, tracked)), ...whole.map((f) => wholeHunk(ch, f))];
}

// The diff text of these files, deletions included, in the order given.
export function diffText(o: Opts, ch: Changes, files: string[]) {
  const whole = files.filter((f) => isWhole(ch, f));
  const tracked = contextDiff(o, files.filter((f) => !whole.includes(f)));
  return [tracked.trimEnd(), ...whole.map((f) => `+++ b/${f}\n${wholeHunk(ch, f).text}`)].filter(Boolean).join("\n");
}

// Added lines with their new-file line numbers, "+<n>" like a hunk's own position.
export function addedOf(h: Hunk) {
  const [header, ...body] = h.text.split("\n");
  let n = Number(/\+(\d+)/.exec(header)?.[1] ?? 1);
  const out: { at: string; text: string }[] = [];
  for (const l of body) {
    if (l.startsWith("+")) out.push({ at: `+${n}`, text: l.slice(1) });
    if (!l.startsWith("-") && !l.startsWith("\\")) n++;
  }
  return out;
}

const CUT = "\n[... cut ...]";
export const clip = (s: string, limit: number) => (s.length <= limit ? s : limit <= CUT.length ? CUT.slice(0, limit) : `${s.slice(0, limit - CUT.length)}${CUT}`);

// Whole items while they fit into `limit` characters of JSON.
export function clippedList(items: string[], limit: number) {
  const out: string[] = [];
  let chars = 2;
  for (const item of items) {
    const next = JSON.stringify(item).length + 1;
    if (chars + next > limit) break;
    out.push(item);
    chars += next;
  }
  return out;
}

// Texts in order, the last one that does not fit cut to what is left.
export function packTexts(texts: string[], limit: number) {
  const out: string[] = [];
  let left = limit;
  for (const text of texts) {
    if (left <= 0) break;
    const part = clip(text, left);
    out.push(part);
    left -= part.length + 3;
  }
  return out;
}

// What a question builder needs: the options, the change, [review], and the model the body names.
export type JevCtx = { o: Opts; ch: Changes; r: Review; model: string };

// The budgets above count characters; JSON escaping adds some. Cut one field by the excess, so the
// serialized state never exceeds MAX_STATE_CHARS. Cutting n raw characters removes at least n.
export function fitState(state: Record<string, string | string[]>, key: string) {
  for (let excess = overBy(state); excess > 0; excess = overBy(state)) {
    const value = state[key];
    if (typeof value === "string") state[key] = clip(value, Math.max(0, value.length - excess - 2));
    else if (!value?.length) return state;
    else state[key] = shorter(value, excess);
  }
  return state;
}

const overBy = (state: object) => JSON.stringify(state).length - MAX_STATE_CHARS;

function shorter(items: string[], excess: number) {
  const last = items.at(-1)!;
  const keep = last.length - excess - 2;
  return keep > 0 ? [...items.slice(0, -1), clip(last, keep)] : items.slice(0, -1);
}
