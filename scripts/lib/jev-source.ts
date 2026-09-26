// Questions on changed source hunks: change_untested on every hunk that changes behaviour, and the
// UX pack (jev-ux.ts) on hunks of files in [review] ux_globs and i18n_globs. All applicable
// questions of one hunk go in one request; the state has only the fields they read.
import { basename } from "node:path";
import type { Opts } from "./config.ts";
import type { Changes } from "./diff.ts";
import { addedOf, bodyOf, clip, clippedList, fitState, type Hunk, hunksOf, type JevCtx, MAX_STATE_CHARS, packTexts, type QBase, type Req, type Review } from "./jev-hunks.ts";
import { type Hit, UX_QUESTIONS, type UxContext, uxContext, type UxQ } from "./jev-ux.ts";
import { adapterForFile, isTestFile } from "./lang.ts";
import { globMatch } from "./util.ts";

// Question wording is fixed: changing it changes what the threshold means.
const CHANGE_UNTESTED: QBase = {
  id: "change_untested",
  label: "the changed behavior has no test in this diff",
  below: true,
  fields: ["source_hunk", "test_hunks"],
  threshold: "change_untested_threshold",
  q: {
    type: "noul",
    instructions: "Does a test in `test_hunks` exercise the behavior changed in `source_hunk`?",
    criteria: {
      true: "A test added or changed in `test_hunks` runs the changed code, directly or through its callers, and checks a result that depends on the lines changed in `source_hunk`.",
      false: "`test_hunks` is empty, or its tests never reach the changed lines, or they only check behavior that the change in `source_hunk` does not affect.",
    },
  },
};

export function sourceFiles(o: Opts, ch: Changes) {
  return [...ch.keys()].filter((file) => adapterForFile(o.langs, file) && !isTestFile(o.langs, file)).sort();
}

// ---- which added lines change behaviour: imports, types, comments and deletions do not

const BLOCK_START = /^\s*(?:export\s+)?(?:declare\s+)?(?:(?:type|interface)\s+\w+|(?:import|export)\s+(?:type\s+)?\{[^}]*$)/;
const TRIVIAL = /^\s*(?:$|\/\/|\/\*|\*|#|--|"""|'''|[)\]}]+[;,]?\s*$|import\b|from\s+\S+\s+import\b|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\b|using\s|use\s|package\s|require\s*\()/;
const braces = (s: string) => (s.match(/\{/g)?.length ?? 0) - (s.match(/\}/g)?.length ?? 0);

function behaviourLines(h: Hunk) {
  let depth = 0;
  return addedOf(h).filter(({ text }) => {
    const typed = depth > 0 || BLOCK_START.test(text);
    if (typed) depth = Math.max(0, depth + braces(text));
    return !typed && !TRIVIAL.test(text);
  });
}

// ---- which files each question reads

type Kinds = { code: (f: string) => boolean; ux: (f: string) => boolean; i18n: (f: string) => boolean };

const list = (r: Review, key: string) => (Array.isArray(r[key]) ? (r[key] as unknown[]).map(String) : []);

// Test support that the test patterns do not name: render harnesses, stories, fixtures, mocks.
const SUPPORT = /[.-](?:\w+-)?harness\.|\.stories\.|(?:^|\/)(?:fixtures?|__mocks__)\//;

function kindsOf(o: Opts, r: Review): Kinds {
  const test = (f: string) => isTestFile(o.langs, f) || SUPPORT.test(f);
  const i18n = (f: string) => globMatch(list(r, "i18n_globs"), f) && !test(f);
  return {
    code: (f) => r.change_untested === true && Boolean(adapterForFile(o.langs, f)) && !test(f) && !i18n(f),
    ux: (f) => globMatch(list(r, "ux_globs"), f) && !test(f),
    i18n,
  };
}

function enabledUx(r: Review) {
  const off = list(r, "ux_off");
  const unknown = off.filter((id) => !UX_QUESTIONS.some((q) => q.id === id));
  if (unknown.length) throw new Error(`unknown review.ux_off id(s) ${unknown.join(", ")}`);
  return UX_QUESTIONS.filter((q) => !off.includes(q.id));
}

const reads = (q: UxQ, k: Kinds, file: string) => (q.on !== "i18n" && k.ux(file)) || (q.on !== "ux" && k.i18n(file));

// ---- requests

type Asked = Hit & { q: QBase };
type SrcCtx = { k: Kinds; uxQs: UxQ[]; uc: UxContext };

function askedOf(h: Hunk, c: SrcCtx): Asked[] {
  const first = c.k.code(h.file) ? behaviourLines(h)[0] : undefined;
  const untested = first ? [{ q: CHANGE_UNTESTED, at: first.at }] : [];
  const ux = c.uxQs.filter((q) => reads(q, c.k, h.file)).flatMap((q) => {
    const hit = q.hit(h, c.uc);
    return hit ? [{ q, ...hit }] : [];
  });
  return [...untested, ...ux];
}

const stem = (f: string) => basename(f).split(".")[0].toLowerCase().replace(/^test_|_test$|_spec$/, "");

// Tests of the same module first: when the budget cuts, it cuts unrelated tests.
const testTexts = (tests: Hunk[], file: string) => {
  const own = (h: Hunk) => stem(h.file) === stem(file);
  return [...tests.filter(own), ...tests.filter((h) => !own(h))].map((h) => `${h.file}\n${h.text}`);
};

function stateOf(h: Hunk, asked: Asked[], tests: Hunk[]) {
  const state: Record<string, string | string[]> = { file: h.file };
  for (const a of asked) for (const [key, items] of Object.entries(a.state ?? {})) state[key] = clippedList(items, MAX_STATE_CHARS / 8);
  state.source_hunk = clip(h.text, MAX_STATE_CHARS / 2);
  if (!asked.some((a) => a.q.fields.includes("test_hunks"))) return fitState(state, "source_hunk");
  const overhead = JSON.stringify({ ...state, test_hunks: [] }).length;
  state.test_hunks = packTexts(testTexts(tests, h.file), MAX_STATE_CHARS - overhead);
  return fitState(state, "test_hunks");
}

function requestOf(model: string, h: Hunk, asked: Asked[], tests: Hunk[]): Req {
  const qs = asked.map((a) => a.q);
  return { hunk: h, qs, body: bodyOf(model, qs, stateOf(h, asked, tests)), at: Object.fromEntries(asked.map((a) => [a.q.id, a.at])) };
}

// --all has no change to hold a test against, and would ask about every file of the repo.
export function sourceRequests(ctx: JevCtx, tests: Hunk[]): Req[] {
  if (ctx.o.scope.kind === "all") return [];
  const k = kindsOf(ctx.o, ctx.r);
  const files = [...ctx.ch.keys()].filter((f) => k.code(f) || k.ux(f) || k.i18n(f)).sort();
  if (!files.length) return [];
  const c: SrcCtx = { k, uxQs: enabledUx(ctx.r), uc: uxContext(ctx.o, k.i18n) };
  const reqs = hunksOf(ctx.o, ctx.ch, files).flatMap((h) => {
    const asked = askedOf(h, c);
    return asked.length ? [requestOf(ctx.model, h, asked, tests)] : [];
  });
  // Hunks with UX questions go first: when jev_max_states cuts, it cuts plain change_untested hunks.
  const withUx = (x: Req) => x.qs.some((q) => q !== CHANGE_UNTESTED);
  return [...reqs.filter(withUx), ...reqs.filter((x) => !withUx(x))];
}
