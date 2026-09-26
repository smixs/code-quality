// spec_incomplete: one question on the whole change, asked when a task spec is given by
// [review] spec (a path in the repo) or, without it, by $QG_SPEC. It never counts against
// jev_max_states: at most one request more.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Changes } from "./diff.ts";
import { bodyOf, CHARS_PER_TOKEN, clip, clippedList, diffText, fitState, type JevCtx, MAX_STATE_CHARS, type QBase, type Req } from "./jev-hunks.ts";
import { adapterForFile, isTestFile } from "./lang.ts";

const SPEC_TOKENS = 8000;
const SPEC_MAX_CHARS = SPEC_TOKENS * CHARS_PER_TOKEN;

// Question wording is fixed: changing it changes what the threshold means.
const SPEC_QUESTION: QBase = {
  id: "spec_incomplete",
  label: "the spec is not fully implemented",
  below: false,
  fields: ["spec", "diff_summary", "diff"],
  threshold: "spec_incomplete_threshold",
  q: {
    type: "noul",
    instructions: "Does `diff` leave at least one requirement stated in `spec` unimplemented or only partly implemented?",
    criteria: {
      true: "At least one requirement in `spec` has no matching change in `diff` and `diff_summary`, or its change covers only part of what `spec` asks.",
      false: "Every requirement stated in `spec` has a matching change in `diff` that does all of what `spec` asks.",
    },
  },
};

type Spec = { path: string; shown: string };

function specOf(ctx: JevCtx, env: NodeJS.ProcessEnv): Spec | null {
  const configured = String(ctx.r.spec ?? "").trim();
  const raw = configured || String(env.QG_SPEC ?? "").trim();
  if (!raw) return null;
  const path = resolve(ctx.o.repo, raw);
  const inside = relative(ctx.o.repo, path);
  return { path, shown: inside.startsWith("..") || isAbsolute(inside) ? raw : inside };
}

function readSpec(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Source files first, then everything else, tests last: a cut diff loses tests before code.
function orderedFiles(ctx: JevCtx) {
  const files = [...ctx.ch.keys()].sort();
  const test = (f: string) => isTestFile(ctx.o.langs, f);
  const source = (f: string) => Boolean(adapterForFile(ctx.o.langs, f)) && !test(f);
  return [...files.filter(source), ...files.filter((f) => !source(f) && !test(f)), ...files.filter(test)];
}

const summaryOf = (ch: Changes) => [...ch.keys()].sort().map((f) => `${f} +${ch.get(f)!.added.size} -${ch.get(f)!.removed.size}`);

function stateOf(ctx: JevCtx, specText: string) {
  const spec = clip(specText, SPEC_MAX_CHARS);
  const diff_summary = clippedList(summaryOf(ctx.ch), MAX_STATE_CHARS / 8);
  const overhead = JSON.stringify({ spec: "", diff_summary, diff: "" }).length;
  const diff = clip(diffText(ctx.o, ctx.ch, orderedFiles(ctx)), Math.max(0, MAX_STATE_CHARS - overhead - spec.length));
  return { state: fitState({ spec, diff_summary, diff }, "diff"), cut: spec.length < specText.length };
}

// No spec is one line, not a silent skip; --all has no change to hold against a spec.
export function specRequests(ctx: JevCtx, env: NodeJS.ProcessEnv): { reqs: Req[]; lines: string[] } {
  if (ctx.r.spec_incomplete !== true || ctx.o.scope.kind === "all" || !ctx.ch.size) return { reqs: [], lines: [] };
  const spec = specOf(ctx, env);
  if (!spec) return { reqs: [], lines: ["jev: spec not set ([review] spec or QG_SPEC)"] };
  const text = readSpec(spec.path);
  if (text === null) return { reqs: [], lines: [`jev: spec not readable (${spec.shown})`] };
  const { state, cut } = stateOf(ctx, text);
  const hunk = { file: spec.shown, at: "", text: "" };
  const suffix = cut ? `spec cut to its first ${SPEC_TOKENS / 1000}k tokens` : undefined;
  return { reqs: [{ hunk, qs: [SPEC_QUESTION], body: bodyOf(ctx.model, [SPEC_QUESTION], state), suffix }], lines: [] };
}
