// Jev review notes: Noul questions asked through a Jev provider (TypeSafe direct, OpenRouter, or a
// custom endpoint with the same contract): five on added test hunks (here), change_untested, the UX
// and agent packs and project questions on changed source hunks (jev-source.ts), spec_incomplete on
// the whole change (jev-spec.ts).
// Notes only: nothing here can change the verdict. Any failure is one "jev: not available (<reason>)"
// line, never a silent pass. Every verdict goes to jev-log.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "./config.ts";
import { addedLines, type Changes } from "./diff.ts";
import { bodyOf, clip, clippedList, type Hunk, hunksOf, type JevCtx, MAX_STATE_CHARS, type QBase, type Req, type Review, thresholdOf } from "./jev-hunks.ts";
import { sourceFiles, sourceRequests } from "./jev-source.ts";
import { specRequests } from "./jev-spec.ts";
import { adapterForFile, isTestFile, matchesTestPattern } from "./lang.ts";
import { localStubShadows } from "./tamper.ts";
import { mainCheckout, run } from "./util.ts";

const TIMEOUT_MS = 5000;
// Code that adds a throw, a catch or an error return: only then is "error path not tested" asked.
const ERROR_ADD = /\bthrow\b|\bcatch\b|\breject\(|\braise\b|\bexcept\b|process\.exit\([1-9]|return\s[^;]*\b(err|error|Err|Error|ok:\s*false)\b/;

type Field = "added_test_code" | "diff_hunk" | "test_hunk" | "changed_source_files";
type QContext = { errorsAdded: boolean; localStub: (h: Hunk) => boolean };
type QDef = QBase & {
  id: QId;
  fields: Field[];
  applies?: (h: Hunk, c: QContext) => boolean;
};
type QId = "textual_test" | "error_path_tested" | "assertion_weakened" | "mock_hides_behavior" | "property_is_tautology";

const replacedLines = (h: Hunk) => h.text.split("\n").some((l) => l.startsWith("+")) && h.text.split("\n").some((l) => l.startsWith("-"));
const PROPERTY = /\bfc\.(?:assert|property)\s*\(|@given\b|\bhypothesis\b/;

// Question wording is fixed: changing it changes what the thresholds mean.
export const QUESTIONS: QDef[] = [
  {
    id: "textual_test",
    label: "a test asserts on the text of a project file",
    below: false,
    fields: ["added_test_code"],
    threshold: "textual_test_threshold",
    q: {
      type: "noul",
      instructions:
        "Does a test in `added_test_code` load the text of a file that is part of the project (source code, configuration, documentation or agent instructions) and then check that text with a string or regular-expression match?",
      criteria: {
        true: "A test reads a project file's contents and asserts that some text is or is not present in it (for example with includes, toContain, match or a regex).",
        false: "The tests call functions, run commands or read files that the test or the code under test created, and check the results; or no test reads a project file's text.",
      },
    },
  },
  {
    id: "error_path_tested",
    label: "the code adds an error path, this test hunk does not exercise one",
    below: true,
    fields: ["diff_hunk"],
    threshold: "error_path_tested_threshold",
    applies: (_h, c) => c.errorsAdded,
    q: {
      type: "noul",
      instructions: "Does the test code added in `diff_hunk` exercise an error, rejection, invalid-input or missing-dependency path of the code under test?",
      criteria: {
        true: "An added test feeds bad or missing input, a failing dependency, or expects a throw, rejection or error result.",
        false: "The added tests only cover successful paths, or no test is added.",
      },
    },
  },
  {
    id: "assertion_weakened",
    label: "the test is easier to pass after weakened assertions",
    below: false,
    fields: ["test_hunk"],
    threshold: "assertion_weakened_threshold",
    applies: (h) => replacedLines(h),
    q: {
      type: "noul",
      instructions:
        "Does the change in `test_hunk` make the test easier to pass than before (assertions removed or loosened, matchers broadened, expected values replaced by any-value checks)?",
      criteria: {
        true: "The removed and added lines weaken or remove an assertion, broaden a matcher, or replace a specific expected value with an any-value check.",
        false: "The assertions are unchanged or stricter, or the changed lines do not alter what the test accepts.",
      },
    },
  },
  {
    id: "mock_hides_behavior",
    label: "a mock or stub hides the changed behavior",
    below: false,
    fields: ["test_hunk", "changed_source_files"],
    threshold: "mock_hides_behavior_threshold",
    applies: (h, c) => c.localStub(h),
    q: {
      type: "noul",
      instructions:
        "Does `test_hunk` replace the code under test or its direct dependency with a mock/stub so the changed behavior in `changed_source_files` is no longer exercised?",
      criteria: {
        true: "The hunk mocks or stubs the code under test or a direct dependency that contains the changed behavior, so the test bypasses that behavior.",
        false: "The mock is outside the changed behavior's path, or the test still exercises the changed behavior through its real implementation and direct dependencies.",
      },
    },
  },
  {
    id: "property_is_tautology",
    label: "the property restates the implementation or filters away generated inputs",
    below: false,
    fields: ["test_hunk"],
    threshold: "property_tautology_threshold",
    applies: (h) => PROPERTY.test(h.text),
    q: {
      type: "noul",
      instructions:
        "Does this property-based test in `test_hunk` restate the implementation (recompute the same algorithm) or filter away almost all generated inputs, so it cannot fail on a real bug?",
      criteria: {
        true: "The expected result repeats the implementation's algorithm, or assumptions and filters discard almost all generated inputs.",
        false: "The property states an independent invariant or relation and exercises a meaningful range of generated inputs.",
      },
    },
  },
];

type Reply = { status: number; text: string };
export type Post = (target: Target, body: unknown, signal: AbortSignal) => Promise<Reply>;
export type JevDeps = { env: NodeJS.ProcessEnv; post: Post };

// ---- provider: where the questions are asked, which key opens it, which model answers

export type ProviderId = "typesafe" | "openrouter" | "custom";
export type Target = { provider: ProviderId; url: string; keyEnv: string; model: string; key: string };

// docs.typesafe.ai/api (21.09.2026): POST <url>, Bearer key, body {state, model, questions}. The
// OpenRouter Decisions endpoint takes the same body; only the model id and the X-Title header differ.
// The model ids are pinned: the thresholds were tuned on 1.13, and the aliases (jev-latest,
// jev-preview) move with every release.
export const PROVIDERS = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", keyEnv: "TYPESAFE_API_KEY", model: "jev-1.13.0" },
  openrouter: { url: "https://openrouter.ai/api/alpha/decisions", keyEnv: "OPENROUTER_API_KEY", model: "typesafe/jev-1.13-20260917" },
} as const;

const str = (r: Review, key: string) => String(r[key] ?? "").trim();

function autoProvider(env: NodeJS.ProcessEnv): "typesafe" | "openrouter" {
  if (env[PROVIDERS.typesafe.keyEnv]) return "typesafe";
  if (env[PROVIDERS.openrouter.keyEnv]) return "openrouter";
  throw new Error(`no ${PROVIDERS.typesafe.keyEnv} or ${PROVIDERS.openrouter.keyEnv}`);
}

function providerOf(r: Review, env: NodeJS.ProcessEnv): ProviderId {
  const id = str(r, "jev_provider") || "auto";
  if (id === "auto") return autoProvider(env);
  if (id === "typesafe" || id === "openrouter" || id === "custom") return id;
  throw new Error(`unknown review.jev_provider ${id}; expected auto | typesafe | openrouter | custom`);
}

function customTarget(r: Review): Omit<Target, "key"> {
  const missing = ["jev_url", "jev_key_env", "jev_model"].filter((key) => !str(r, key));
  if (missing.length) throw new Error(`review.jev_provider = custom needs ${missing.map((key) => `review.${key}`).join(", ")}`);
  return { provider: "custom", url: str(r, "jev_url"), keyEnv: str(r, "jev_key_env"), model: str(r, "jev_model") };
}

function knownTarget(provider: "typesafe" | "openrouter", r: Review): Omit<Target, "key"> {
  const d = PROVIDERS[provider];
  return { provider, url: str(r, "jev_url") || d.url, keyEnv: str(r, "jev_key_env") || d.keyEnv, model: str(r, "jev_model") || d.model };
}

// The reason is the text of "jev: not available (<reason>)": a missing key is never a silent pass.
export function jevTarget(r: Review, env: NodeJS.ProcessEnv): Target {
  const provider = providerOf(r, env);
  const base = provider === "custom" ? customTarget(r) : knownTarget(provider, r);
  const key = env[base.keyEnv] ?? "";
  if (!key) throw new Error(`${base.keyEnv} is not set`);
  return { ...base, key };
}

export function jevHeaders(target: Target): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" };
  if (target.provider === "openrouter") headers["X-Title"] = "code-quality";
  return headers;
}

export const postWith = (fetchImpl: typeof fetch): Post => async (target, body, signal) => {
  const res = await fetchImpl(target.url, { method: "POST", headers: jevHeaders(target), body: JSON.stringify(body), signal });
  return { status: res.status, text: await res.text() };
};

export const defaultJev = (): JevDeps => ({ env: process.env, post: postWith(fetch) });

// ---- test hunks: added test hunks with 3 lines of context, as Jev expects them

export function testHunks(o: Opts, ch: Changes): Hunk[] {
  return hunksOf(o, ch, [...ch.keys()].filter((f) => isTestFile(o.langs, f)));
}

export const codeAddsErrors = (o: Opts, ch: Changes) => addedLines(ch, (file) => Boolean(adapterForFile(o.langs, file)) && !isTestFile(o.langs, file)).some((x) => ERROR_ADD.test(x.text));

// ---- test requests: all applicable questions of one hunk in one request; state has only fields they read

function enabledQs(r: Review, h: Hunk, context: QContext) {
  return QUESTIONS.filter((q) => r[q.id] === true && (!q.applies || q.applies(h, context)));
}

const addedCode = (h: Hunk) => h.text.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");

function stateOf(h: Hunk, qs: QDef[], changedSourceFiles: string[]) {
  const fields = new Set(qs.flatMap((q) => q.fields));
  const state: Record<string, string | string[]> = { file: h.file };
  if (fields.has("changed_source_files")) state.changed_source_files = clippedList(changedSourceFiles, MAX_STATE_CHARS / 4);
  const texts = [...fields].filter((f) => f !== "changed_source_files");
  const overhead = JSON.stringify({ ...state, ...Object.fromEntries(texts.map((f) => [f, ""])) }).length;
  const perField = Math.max(0, Math.floor((MAX_STATE_CHARS - overhead) / Math.max(1, texts.length)));
  if (fields.has("added_test_code")) state.added_test_code = clip(addedCode(h), perField);
  if (fields.has("diff_hunk")) state.diff_hunk = clip(h.text, perField);
  if (fields.has("test_hunk")) state.test_hunk = clip(h.text, perField);
  return state;
}

function testRequests(ctx: JevCtx, hunks: Hunk[]): Req[] {
  const { o, ch, r, model } = ctx;
  const context = { errorsAdded: codeAddsErrors(o, ch), localStub: (h: Hunk) => hasMock(o, ch, h) };
  const changedSourceFiles = sourceFiles(o, ch);
  return hunks.flatMap((h) => {
    const qs = enabledQs(r, h, context);
    return qs.length ? [{ hunk: h, qs, body: bodyOf(model, qs, stateOf(h, qs, changedSourceFiles)) }] : [];
  });
}

function hasMock(o: Opts, ch: Changes, h: Hunk) {
  const adapter = adapterForFile(o.langs, h.file);
  if (adapter && matchesTestPattern(adapter, "mock", h.text)) return true;
  return localStubShadows(o, ch, h.file, addedForStub(h)).length > 0;
}

function addedForStub(h: Hunk) {
  return h.text.split("\n").filter((line) => line.startsWith("+")).map((text, line) => ({ line, text: text.slice(1) }));
}

// ---- asking and reading the answers

type Verdict = { q: QBase; hunk: Hunk; p: number; model: string; at: string; why: string; suffix: string };

// The provider answers with the versioned model id: that is what the log records, not the request's.
async function ask(d: JevDeps, target: Target, r: Req, signal: AbortSignal): Promise<Verdict[]> {
  const res = await d.post(target, r.body, signal);
  if (res.status !== 200) throw new Error(`${target.provider} ${res.status}`);
  const answer = JSON.parse(res.text);
  const model = typeof answer.model === "string" && answer.model ? answer.model : target.model;
  return r.qs.map((q) => ({ q, hunk: r.hunk, p: noulOf(answer.answers, q.id), model, at: r.at?.[q.id] ?? r.hunk.at, why: whyOf(answer.answers, q.id), suffix: r.suffix ?? "" }));
}

type Answers = Record<string, { noul?: unknown; reason?: unknown; explanation?: unknown }> | undefined;

function noulOf(answers: Answers, id: string) {
  const p = answers?.[id]?.noul;
  if (typeof p !== "number") throw new Error(`no noul for ${id} in the answer`);
  return p;
}

// The documented Noul answer is a probability only; a text, when a provider adds one, goes into the note.
function whyOf(answers: Answers, id: string) {
  const a = answers?.[id];
  const text = typeof a?.reason === "string" ? a.reason : typeof a?.explanation === "string" ? a.explanation : "";
  return text.replace(/\s+/g, " ").trim();
}

const TIMEOUTS = new Set(["TimeoutError", "AbortError"]);

function reasonOf(e: unknown) {
  if (!(e instanceof Error)) return String(e);
  return TIMEOUTS.has(e.name) ? `timeout after ${TIMEOUT_MS / 1000}s` : e.message;
}

const noted = (v: Verdict, r: Review) => {
  const t = thresholdOf(v.q, r);
  return v.q.below ? v.p < t : v.p >= t;
};

const place = (v: Verdict) => (v.at ? `${v.hunk.file}:${v.at}` : v.hunk.file);

function noteLine(v: Verdict, r: Review) {
  const side = v.q.below ? "<" : ">=";
  const tail = [v.why && `: ${v.why}`, v.suffix && ` (${v.suffix})`].filter(Boolean).join("");
  return `note: jev ${v.q.id} p=${v.p.toFixed(2)} ${side} ${thresholdOf(v.q, r)}  ${place(v)}  ${v.q.label}${tail}`;
}

// A cut state is said even when the answer is not a note: the probability covers only what was sent.
const suffixLine = (v: Verdict) => `jev: ${v.q.id} p=${v.p.toFixed(2)}, ${v.suffix}`;

function logVerdicts(o: Opts, vs: Verdict[], r: Review) {
  const dir = join(mainCheckout(o.repo), o.outDir);
  mkdirSync(dir, { recursive: true });
  const sha = run("git", ["rev-parse", "--short", "HEAD"], o.repo).out.trim();
  const ts = new Date().toISOString();
  const rows = vs.map((v) => JSON.stringify({ ts, question: v.q.id, p: v.p, file: v.hunk.file, hunk: v.at, sha, scope: o.scope.kind, model: v.model, noted: noted(v, r) }));
  if (rows.length) appendFileSync(join(dir, "jev-log.jsonl"), `${rows.join("\n")}\n`);
}

// Every request failing the same way is one reason (a 401 key, a 429 wall); a partial failure says how many.
function failLine(failed: string[], total: number) {
  if (!failed.length) return [];
  const same = failed.length === total && failed.every((reason) => reason === failed[0]);
  return [`jev: not available (${same ? failed[0] : `${failed.length} of ${total} request(s): ${failed[0]}`})`];
}

type AskCtx = { o: Opts; d: JevDeps; target: Target; r: Review };

async function askAll(ctx: AskCtx, reqs: Req[]) {
  const { o, d, target, r } = ctx;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const settled = await Promise.allSettled(reqs.map((x) => ask(d, target, x, signal)));
  const vs = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const failed = settled.flatMap((s) => (s.status === "rejected" ? [reasonOf(s.reason)] : []));
  logVerdicts(o, vs, r);
  const notes = vs.filter((v) => noted(v, r)).map((v) => noteLine(v, r));
  const cut = vs.filter((v) => v.suffix && !noted(v, r)).map(suffixLine);
  const model = vs[0]?.model ?? target.model;
  return [...notes, ...cut, ...failLine(failed, reqs.length), `jev: ${reqs.length - failed.length} of ${reqs.length} request(s) answered, ${notes.length} note(s), ${target.provider} ${model}`];
}

// Hunk requests (test hunks first, then source hunks) share jev_max_states; the spec request is one more.
function requests(o: Opts, ch: Changes, r: Review, model: string) {
  const tests = testHunks(o, ch);
  const hunkReqs = [...testRequests({ o, ch, r, model }, tests), ...sourceRequests({ o, ch, r, model }, tests, [...QUESTIONS.map((q) => q.id), "spec_incomplete"])];
  const reqs = hunkReqs.slice(0, Number(r.jev_max_states));
  return { reqs, total: hunkReqs.length };
}

async function jevLines(o: Opts, ch: Changes, d: JevDeps) {
  const r = o.toml.review as Review;
  const target = jevTarget(r, d.env);
  const { reqs, total } = requests(o, ch, r, target.model);
  const spec = specRequests({ o, ch, r, model: target.model }, d.env);
  const all = [...reqs, ...spec.reqs];
  if (!all.length) return [...spec.lines, "jev: nothing to ask (no test or source hunks)"];
  const capped = total > reqs.length ? [`jev: asked ${reqs.length} of ${total} hunks (jev_max_states)`] : [];
  return [...capped, ...spec.lines, ...(await askAll({ o, d, target, r }, all))];
}

// Boundary: whatever breaks inside (git, the log file, the answer) becomes one line, never a throw.
export async function jevNotes(o: Opts, ch: Changes, d: JevDeps): Promise<string[]> {
  try {
    return await jevLines(o, ch, d);
  } catch (e) {
    return [`jev: not available (${reasonOf(e)})`];
  }
}
