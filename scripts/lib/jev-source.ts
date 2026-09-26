// Questions on changed source hunks: change_untested on every hunk that changes behaviour, the UX
// pack (jev-ux.ts, [review] ux_globs / i18n_globs), the agent pack (jev-agent.ts, agent_globs /
// agent_prompt_globs) and project questions (jev-custom.ts, [[review.jev_questions]]). All
// applicable questions of one hunk go in one request; the state has only the fields they read.
import { basename } from "node:path";
import type { Opts } from "./config.ts";
import type { Changes } from "./diff.ts";
import { AGENT_QUESTIONS } from "./jev-agent.ts";
import { customKind, customQuestions } from "./jev-custom.ts";
import { addedOf, bodyOf, clip, clippedList, fitState, type Hit, type HitContext, hitContext, type Hunk, hunksOf, type JevCtx, MAX_STATE_CHARS, packTexts, type PackQ, type QBase, type Req, type Review } from "./jev-hunks.ts";
import { UX_QUESTIONS } from "./jev-ux.ts";
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

// A pack: its enabled questions and the file kinds they read (ux/i18n, code/prompt, one per project question).
type Pack = { qs: PackQ[]; kinds: Record<string, (f: string) => boolean> };

const list = (r: Review, key: string) => (Array.isArray(r[key]) ? (r[key] as unknown[]).map(String) : []);

// Test support that the test patterns do not name: render harnesses, stories, fixtures, mocks.
const SUPPORT = /[.-](?:\w+-)?harness\.|\.stories\.|(?:^|\/)(?:fixtures?|__mocks__)\//;

function enabled(r: Review, key: string, qs: PackQ[]) {
  const off = list(r, key);
  const unknown = off.filter((id) => !qs.some((q) => q.id === id));
  if (unknown.length) throw new Error(`unknown review.${key} id(s) ${unknown.join(", ")}`);
  return qs.filter((q) => !off.includes(q.id));
}

function packsOf(r: Review, test: (f: string) => boolean, taken: string[]): Pack[] {
  const glob = (key: string) => (f: string) => globMatch(list(r, key), f) && !test(f);
  const custom = customQuestions(r, [...taken, CHANGE_UNTESTED.id, ...UX_QUESTIONS.map((q) => q.id), ...AGENT_QUESTIONS.map((q) => q.id)]);
  return [
    { qs: enabled(r, "ux_off", UX_QUESTIONS), kinds: { ux: glob("ux_globs"), i18n: glob("i18n_globs") } },
    { qs: enabled(r, "agent_off", AGENT_QUESTIONS), kinds: { code: glob("agent_globs"), prompt: glob("agent_prompt_globs") } },
    { qs: custom.qs, kinds: Object.fromEntries(custom.qs.map((q) => [q.id, (f: string) => customKind(custom, f, q.id) && !test(f)])) },
  ];
}

const inPack = (p: Pack, f: string) => Object.values(p.kinds).some((kind) => kind(f));
const reads = (p: Pack, q: PackQ, f: string) => (q.on === "both" ? inPack(p, f) : Boolean(p.kinds[q.on]?.(f)));

// ---- requests

type Asked = Hit & { q: QBase };
type SrcCtx = { code: (f: string) => boolean; packs: Pack[]; hc: HitContext };

function askedOf(h: Hunk, c: SrcCtx): Asked[] {
  const first = c.code(h.file) ? behaviourLines(h)[0] : undefined;
  const untested = first ? [{ q: CHANGE_UNTESTED, at: first.at }] : [];
  const packs = c.packs.flatMap((p) => p.qs.filter((q) => reads(p, q, h.file))).flatMap((q) => {
    const hit = q.hit(h, c.hc);
    return hit ? [{ q, ...hit }] : [];
  });
  return [...untested, ...packs];
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
// taken: ids of the test-hunk questions, which project questions may not reuse.
export function sourceRequests(ctx: JevCtx, tests: Hunk[], taken: string[]): Req[] {
  if (ctx.o.scope.kind === "all") return [];
  const test = (f: string) => isTestFile(ctx.o.langs, f) || SUPPORT.test(f);
  const packs = packsOf(ctx.r, test, taken);
  const i18n = packs[0].kinds.i18n;
  const code = (f: string) => ctx.r.change_untested === true && Boolean(adapterForFile(ctx.o.langs, f)) && !test(f) && !i18n(f);
  const files = [...ctx.ch.keys()].filter((f) => code(f) || packs.some((p) => inPack(p, f))).sort();
  if (!files.length) return [];
  const kind = (f: string, name: string) => packs.some((p) => Boolean(p.kinds[name]?.(f)));
  const c: SrcCtx = { code, packs, hc: hitContext(ctx.o, kind, sourceFiles(ctx.o, ctx.ch)) };
  const reqs = hunksOf(ctx.o, ctx.ch, files).flatMap((h) => {
    const asked = askedOf(h, c);
    return asked.length ? [requestOf(ctx.model, h, asked, tests)] : [];
  });
  // Hunks with pack or project questions go first: jev_max_states then cuts plain change_untested hunks.
  const withPack = (x: Req) => x.qs.some((q) => q !== CHANGE_UNTESTED);
  return [...reqs.filter(withPack), ...reqs.filter((x) => !withPack(x))];
}
