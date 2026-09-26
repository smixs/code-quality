// Jev provider resolution and the two HTTP providers (TypeSafe direct, OpenRouter). No network:
// fetch is injected, so every round trip below is a stub with the documented response shape.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpts, DEFAULTS, readArgs } from "./config.ts";
import { changes } from "./diff.ts";
import { jevHeaders, jevNotes, jevTarget, type Post, postWith } from "./jev.ts";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "qg-jev-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });

// One staged change: the code adds a throw, the added test reads a source file's text.
function jevRepo() {
  const repo = tmp();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[review]\njev = true\n');
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeFileSync(join(repo, "src/a.ts"), "export const a = (x: number) => x;\n");
  sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
  writeFileSync(join(repo, "src/a.ts"), 'export const a = (x: number) => {\n  if (x < 0) throw new Error("negative");\n  return x;\n};\n');
  writeFileSync(join(repo, "src/a.test.ts"), 'import { readFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("t", () => { readFileSync("src/a.ts", "utf8").includes("throw"); });\n');
  sh(repo, "git add -A");
  return buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"]));
}

const review = (over: Record<string, string> = {}) => ({ ...DEFAULTS.review, ...over }) as Record<string, unknown>;
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";

describe("jev provider resolution", () => {
  const cases: [string, Record<string, string>, NodeJS.ProcessEnv, string[]][] = [
    ["auto prefers TypeSafe when its key is set", {}, { TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" }, ["typesafe", TYPESAFE_URL, "TYPESAFE_API_KEY", "jev-1.13.0", "t"]],
    ["auto falls back to OpenRouter", {}, { OPENROUTER_API_KEY: "o" }, ["openrouter", OPENROUTER_URL, "OPENROUTER_API_KEY", "typesafe/jev-1.13-20260917", "o"]],
    ["an explicit provider ignores the other key", { jev_provider: "openrouter" }, { TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" }, ["openrouter", OPENROUTER_URL, "OPENROUTER_API_KEY", "typesafe/jev-1.13-20260917", "o"]],
    ["typesafe can be chosen with only its key", { jev_provider: "typesafe" }, { TYPESAFE_API_KEY: "t" }, ["typesafe", TYPESAFE_URL, "TYPESAFE_API_KEY", "jev-1.13.0", "t"]],
    ["config overrides url, key env and model", { jev_provider: "typesafe", jev_url: "https://mirror/v1", jev_key_env: "MY_KEY", jev_model: "jev-preview" }, { MY_KEY: "m" }, ["typesafe", "https://mirror/v1", "MY_KEY", "jev-preview", "m"]],
    ["custom takes everything from the config", { jev_provider: "custom", jev_url: "https://in-house/decisions", jev_key_env: "IN_HOUSE_KEY", jev_model: "jev-1.13.0" }, { IN_HOUSE_KEY: "h" }, ["custom", "https://in-house/decisions", "IN_HOUSE_KEY", "jev-1.13.0", "h"]],
  ];
  for (const [name, config, env, expected] of cases) {
    test(name, () => {
      const t = jevTarget(review(config), env);
      expect([t.provider, t.url, t.keyEnv, t.model, t.key]).toEqual(expected as [string, string, string, string, string]);
    });
  }

  test("no key at all names both environment variables", () => {
    expect(() => jevTarget(review(), {})).toThrow("no TYPESAFE_API_KEY or OPENROUTER_API_KEY");
  });

  test("an explicit provider without its key names that variable", () => {
    expect(() => jevTarget(review({ jev_provider: "typesafe" }), { OPENROUTER_API_KEY: "o" })).toThrow("TYPESAFE_API_KEY is not set");
  });

  test("custom requires url and key env", () => {
    expect(() => jevTarget(review({ jev_provider: "custom" }), { X: "1" })).toThrow("review.jev_url, review.jev_key_env");
  });

  test("an unknown provider names the key and the choices", () => {
    expect(() => jevTarget(review({ jev_provider: "vendor" }), {})).toThrow("review.jev_provider vendor");
  });

  test("X-Title is sent to OpenRouter only", () => {
    const openrouter = jevHeaders(jevTarget(review({ jev_provider: "openrouter" }), { OPENROUTER_API_KEY: "o" }));
    const typesafe = jevHeaders(jevTarget(review({ jev_provider: "typesafe" }), { TYPESAFE_API_KEY: "t" }));
    expect([openrouter["X-Title"], openrouter.Authorization]).toEqual(["code-quality", "Bearer o"]);
    expect(["X-Title" in typesafe, typesafe.Authorization]).toEqual([false, "Bearer t"]);
  });
});

type Call = { url: string; headers: Record<string, string>; body: any };

// The documented answer shape of both providers: {model, answers: {<id>: {type, noul}}, usage}.
function stubFetch(calls: Call[], status = 200, model = "jev-1.13.0-20260917") {
  return (async (url: string | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }]));
    const text = JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2 } });
    return new Response(status === 200 ? text : "upstream", { status });
  }) as unknown as typeof fetch;
}

describe("jev round trip", () => {
  const providers: [string, NodeJS.ProcessEnv, string, string][] = [
    ["typesafe", { TYPESAFE_API_KEY: "t" }, TYPESAFE_URL, "jev-1.13.0"],
    ["openrouter", { OPENROUTER_API_KEY: "o" }, OPENROUTER_URL, "typesafe/jev-1.13-20260917"],
  ];
  for (const [provider, env, url, model] of providers) {
    test(`${provider}: one request per hunk with the documented body, the answered model is logged`, async () => {
      const o = jevRepo();
      const calls: Call[] = [];
      const lines = await jevNotes(o, changes(o), { env, post: postWith(stubFetch(calls, 200, `${model}-answered`)) });
      expect(calls.map((c) => [c.url, c.body.model, Object.keys(c.body.state).sort()])).toEqual([
        [url, model, ["added_test_code", "diff_hunk", "file"]],
        [url, model, ["file", "source_hunk", "test_hunks"]],
      ]);
      expect(lines.filter((l) => l.startsWith("note: jev")).map((l) => l.split(" ")[2])).toEqual(["textual_test"]);
      const log = readFileSync(join(o.repo, ".scratch/quality/jev-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect([...new Set(log.map((r) => r.model))]).toEqual([`${model}-answered`]);
    }, 60_000);
  }

  for (const status of [401, 429, 529]) {
    test(`HTTP ${status} is one not-available line naming the provider`, async () => {
      const o = jevRepo();
      const lines = await jevNotes(o, changes(o), { env: { OPENROUTER_API_KEY: "o" }, post: postWith(stubFetch([], status)) });
      expect(lines.filter((l) => l.startsWith("jev: not available"))).toEqual([`jev: not available (openrouter ${status})`]);
    }, 60_000);
  }

  test("a missing key is one line and no request", async () => {
    const o = jevRepo();
    const calls: unknown[] = [];
    const post: Post = async (_target, body) => {
      calls.push(body);
      return { status: 200, text: "{}" };
    };
    expect(await jevNotes(o, changes(o), { env: {}, post })).toEqual(["jev: not available (no TYPESAFE_API_KEY or OPENROUTER_API_KEY)"]);
    expect(calls).toEqual([]);
  }, 60_000);
});

// ---- change_untested, spec_incomplete and the UX pack: staged fixtures, answers from a stub

type Files = Record<string, string>;

function writeAll(repo: string, files: Files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

// before is committed, after is staged; review is the body of [review] after `jev = true`.
function stagedRepo(before: Files, after: Files, review = "") {
  const repo = tmp();
  writeFileSync(join(repo, ".quality.toml"), `[project]\nlanguage = "ts"\nsrc = ["src", "apps"]\nbase = "HEAD"\n[review]\njev = true\n${review}\n`);
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeAll(repo, before);
  sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
  writeAll(repo, after);
  sh(repo, "git add -A");
  return buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"]));
}

type Answer = { noul: number; reason?: string };

// Answers every question it is asked; p (and an optional reason) per question id, 0.5 otherwise.
function answering(calls: Call[], by: Record<string, Answer> = {}): Post {
  return async (_target, body) => {
    const b = body as Call["body"];
    calls.push({ url: "", headers: {}, body: b });
    const answers = Object.fromEntries(Object.keys(b.questions).map((id) => [id, { type: "noul", ...(by[id] ?? { noul: 0.5 }) }]));
    return { status: 200, text: JSON.stringify({ model: "jev-test", answers }) };
  };
}

const KEY = { TYPESAFE_API_KEY: "t" };
const notes = (lines: string[]) => lines.filter((l) => l.startsWith("note: jev"));
const asked = (calls: Call[]) => calls.map((c) => Object.keys(c.body.questions));
const logOf = (repo: string) => readFileSync(join(repo, ".scratch/quality/jev-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const SUM_BEFORE = { "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n" };
const SUM_AFTER = { "src/sum.ts": "export const sum = (a: number, b: number) => {\n  if (a < 0) return 0;\n  return a + b;\n};\n" };

describe("jev change_untested", () => {
  test("a changed source hunk without a test in the diff: empty test_hunks, p below 0.5 is a note", async () => {
    const o = stagedRepo(SUM_BEFORE, SUM_AFTER);
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { change_untested: { noul: 0.1 } }) });
    expect(asked(calls)).toEqual([["change_untested"]]);
    expect([Object.keys(calls[0].body.state), calls[0].body.state.test_hunks]).toEqual([["file", "source_hunk", "test_hunks"], []]);
    expect(calls[0].body.state.source_hunk).toContain("+  if (a < 0) return 0;");
    expect(notes(lines)).toEqual(["note: jev change_untested p=0.10 < 0.5  src/sum.ts:+1  the changed behavior has no test in this diff"]);
    expect(logOf(o.repo).map((r) => [r.question, r.file, r.hunk, r.scope, r.noted])).toEqual([["change_untested", "src/sum.ts", "+1", "staged", true]]);
    expect(lines.at(-1)).toBe("jev: 1 of 1 request(s) answered, 1 note(s), typesafe jev-test");
  }, 60_000);

  test("a test added in the same diff goes into test_hunks; p at 0.5 is no note", async () => {
    const test = 'import { expect, test } from "bun:test";\nimport { sum } from "./sum.ts";\ntest("negative", () => expect(sum(-1, 2)).toBe(0));\n';
    const o = stagedRepo(SUM_BEFORE, { ...SUM_AFTER, "src/sum.test.ts": test });
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { change_untested: { noul: 0.5 } }) });
    const source = calls.find((c) => "change_untested" in c.body.questions)!;
    expect(source.body.state.test_hunks).toHaveLength(1);
    expect(source.body.state.test_hunks[0]).toContain("expect(sum(-1, 2)).toBe(0)");
    expect(notes(lines).filter((l) => l.includes("change_untested"))).toEqual([]);
  }, 60_000);

  test("hunks of imports, types, comments or deletions only are not asked", async () => {
    const before = { "src/t.ts": "export const keep = 1;\nexport const gone = 2;\n" };
    const after = {
      "src/t.ts": 'import { x } from "./x.ts";\n// a comment\nexport type T = {\n  a: string;\n};\nexport interface I {\n  b: number;\n}\nexport const keep = 1;\n',
    };
    const o = stagedRepo(before, after);
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect([calls, lines]).toEqual([[], ["jev: spec not set ([review] spec or QG_SPEC)", "jev: nothing to ask (no test or source hunks)"]]);
  }, 60_000);

  test("change_untested = false switches it off", async () => {
    const o = stagedRepo(SUM_BEFORE, SUM_AFTER, "change_untested = false");
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(calls).toEqual([]);
  }, 60_000);
});

const SPEC = "# Task\n\n1. sum returns 0 for a negative first argument.\n2. sum logs every call.\n";

describe("jev spec_incomplete", () => {
  test("no [review] spec and no QG_SPEC: one line and no spec request", async () => {
    const o = stagedRepo(SUM_BEFORE, SUM_AFTER);
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(lines).toContain("jev: spec not set ([review] spec or QG_SPEC)");
    expect(asked(calls).flat()).not.toContain("spec_incomplete");
  }, 60_000);

  test("a spec that is implemented in full: spec, diff_summary and diff are sent, p below 0.7 is no note", async () => {
    const o = stagedRepo({ ...SUM_BEFORE, "docs/spec.md": SPEC }, SUM_AFTER, 'spec = "docs/spec.md"');
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { spec_incomplete: { noul: 0.2 } }) });
    const spec = calls.find((c) => "spec_incomplete" in c.body.questions)!;
    expect([Object.keys(spec.body.questions), Object.keys(spec.body.state)]).toEqual([["spec_incomplete"], ["spec", "diff_summary", "diff"]]);
    expect([spec.body.state.spec, spec.body.state.diff_summary]).toEqual([SPEC, ["src/sum.ts +4 -1"]]);
    expect(spec.body.state.diff).toContain("+  if (a < 0) return 0;");
    expect(notes(lines).filter((l) => l.includes("spec_incomplete"))).toEqual([]);
    expect(logOf(o.repo).find((r) => r.question === "spec_incomplete")).toMatchObject({ file: "docs/spec.md", p: 0.2, noted: false });
  }, 60_000);

  test("a spec that is implemented in part, taken from QG_SPEC: the note carries the answer's text", async () => {
    const o = stagedRepo({ ...SUM_BEFORE, "docs/spec.md": SPEC }, SUM_AFTER);
    const calls: Call[] = [];
    const post = answering(calls, { spec_incomplete: { noul: 0.86, reason: "item 2, logging, has no change" } });
    const lines = await jevNotes(o, changes(o), { env: { ...KEY, QG_SPEC: "docs/spec.md" }, post });
    expect(notes(lines).filter((l) => l.includes("spec_incomplete"))).toEqual([
      "note: jev spec_incomplete p=0.86 >= 0.7  docs/spec.md  the spec is not fully implemented: item 2, logging, has no change",
    ]);
  }, 60_000);

  test("[review] spec wins over QG_SPEC; a missing file is one line", async () => {
    const o = stagedRepo(SUM_BEFORE, SUM_AFTER, 'spec = "docs/missing.md"');
    const lines = await jevNotes(o, changes(o), { env: { ...KEY, QG_SPEC: "docs/other.md" }, post: answering([]) });
    expect(lines).toContain("jev: spec not readable (docs/missing.md)");
  }, 60_000);

  test("a spec over 8k tokens is cut and the note says so; the spec is one request beyond jev_max_states", async () => {
    const long = `${SPEC}${"- a detail that is not in the head of the spec\n".repeat(400)}`;
    const o = stagedRepo({ ...SUM_BEFORE, "src/b.ts": "export const b = 1;\n", "docs/spec.md": long }, { ...SUM_AFTER, "src/b.ts": "export const b = () => 2;\n" }, 'spec = "docs/spec.md"\njev_max_states = 1');
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { spec_incomplete: { noul: 0.9 }, change_untested: { noul: 0.9 } }) });
    expect(asked(calls)).toEqual([["change_untested"], ["spec_incomplete"]]);
    const spec = calls[1].body.state.spec as string;
    expect([spec.length <= 10_000, spec.endsWith("[... cut ...]")]).toEqual([true, true]);
    expect(lines).toContain("jev: asked 1 of 2 hunks (jev_max_states)");
    expect(notes(lines)).toEqual(["note: jev spec_incomplete p=0.90 >= 0.7  docs/spec.md  the spec is not fully implemented (spec cut to its first 8k tokens)"]);
    const quiet = await jevNotes(o, changes(o), { env: KEY, post: answering([], { spec_incomplete: { noul: 0.3 } }) });
    expect(quiet).toContain("jev: spec_incomplete p=0.30, spec cut to its first 8k tokens");
  }, 60_000);
});

const UX = 'ux_globs = ["src/ui/**/*.tsx"]\ni18n_globs = ["src/i18n/*.ts"]\nchange_untested = false\nspec_incomplete = false';
const SCREEN = "src/ui/Screen.tsx";

// A one-file change: before is committed, before + added is staged.
function oneFile(file: string, added: string, review: string, before = "export const x = 1;\n") {
  return stagedRepo({ [file]: before }, { [file]: `${before}${added}\n` }, review);
}

// The question is asked in one request with the others its trigger found; the note names file and line.
async function expectAsked(o: ReturnType<typeof stagedRepo>, id: string, file: string) {
  const calls: Call[] = [];
  const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { [id]: { noul: 0.7 } }) });
  expect(asked(calls)).toHaveLength(1);
  expect(asked(calls)[0]).toContain(id);
  expect(Object.keys(calls[0].body.state)[0]).toBe("file");
  expect(notes(lines).find((l) => l.includes(` ${id} `))).toMatch(new RegExp(`^note: jev ${id} p=0\\.70 >= 0\\.7  ${file.replace(/\./g, "\\.")}:\\+\\d+  [a-z]`));
}

describe("jev UX pack", () => {
  // Each snippet is the added part of src/ui/Screen.tsx and must trigger its question.
  const cases: [string, string][] = [
    ["hardcoded_color", '<div className="bg-[#ff0000]" />'],
    ["jargon_in_ui", "<p>Paste the Chat ID here</p>"],
    ["text_not_plain", '<p title="The value that has been entered here will be used by the system for all of the future orders">x</p>'],
    ["metric_without_deeplink", "<Card><CardTitle>Analytics</CardTitle><span>{total}</span></Card>"],
    ["mobile_not_handled", '<div className="grid grid-cols-4 gap-2" />'],
    ["raw_error_shown", "{error.message}"],
    ["empty_state_dead_end", "{items.length === 0 && <p>{t.none}</p>}"],
  ];
  for (const [id, added] of cases) {
    test(`${id}: its trigger asks it; the note has file, line and meaning`, async () => {
      const o = oneFile(SCREEN, added, UX);
      const calls: Call[] = [];
      const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { [id]: { noul: 0.7 } }) });
      expect(asked(calls)).toHaveLength(1);
      expect(asked(calls)[0]).toContain(id);
      expect(Object.keys(calls[0].body.state).slice(0, 1)).toEqual(["file"]);
      expect(notes(lines).find((l) => l.includes(` ${id} `))).toMatch(new RegExp(`^note: jev ${id} p=0\\.70 >= 0\\.7  src/ui/Screen\\.tsx:\\+\\d+  [a-z]`));
    }, 60_000);
  }

  test("a plain logic hunk triggers no UX question, and nothing is asked without ux_globs", async () => {
    const calls: Call[] = [];
    const o = oneFile(SCREEN, "export const y = (a: number) => a * 2;", UX);
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    const off = oneFile(SCREEN, '<div className="bg-[#ff0000]" />', "change_untested = false");
    await jevNotes(off, changes(off), { env: KEY, post: answering(calls) });
    expect(calls).toEqual([]);
  }, 60_000);

  test("pack hunks go first under jev_max_states; render harnesses and stories get no question", async () => {
    const color = '<div className="bg-[#ff0000]" />\n';
    const before = { ...SUM_BEFORE, [SCREEN]: "\n", "src/ui/Screen.render-harness.tsx": "\n", "src/ui/Screen.stories.tsx": "\n" };
    const after = { ...SUM_AFTER, [SCREEN]: color, "src/ui/Screen.render-harness.tsx": color, "src/ui/Screen.stories.tsx": color };
    const o = stagedRepo(before, after, 'ux_globs = ["src/ui/**/*.tsx"]\nspec_incomplete = false\njev_max_states = 1');
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(calls.map((c) => c.body.state.file)).toEqual([SCREEN]);
    expect(lines).toContain("jev: asked 1 of 2 hunks (jev_max_states)");
  }, 60_000);

  test("semantic color classes and design tokens do not ask hardcoded_color", async () => {
    const o = oneFile(SCREEN, '<div className="bg-primary text-muted-foreground border-[var(--line)]" />', UX);
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(asked(calls).flat()).not.toContain("hardcoded_color");
  }, 60_000);

  test("duplicate_control sends the other lines with the same label", async () => {
    const before = "<Button onClick={save}>Save</Button>\n<p>form</p>\n";
    const o = oneFile("src/ui/Form.tsx", "<Button onClick={save}>Save</Button>", UX, before);
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(asked(calls)[0]).toContain("duplicate_control");
    expect(calls[0].body.state.same_label_lines).toEqual(["src/ui/Form.tsx:1: <Button onClick={save}>Save</Button>"]);
  }, 60_000);

  test("feature_not_wired: a component only its test names is asked with the references; a rendered one is not", async () => {
    const screen = "export function NewScreen() {\n  return <div />;\n}\n";
    const lonely = stagedRepo({ "src/ui/App.tsx": "export const App = 1;\n" }, {
      "src/ui/NewScreen.tsx": screen,
      "src/ui/NewScreen.test.tsx": 'import { NewScreen } from "./NewScreen";\nNewScreen();\n',
    }, UX);
    const calls: Call[] = [];
    await jevNotes(lonely, changes(lonely), { env: KEY, post: answering(calls) });
    const wiring = calls.find((c) => "feature_not_wired" in c.body.questions)!;
    expect(wiring.body.state.references).toEqual(['src/ui/NewScreen.test.tsx:1: import { NewScreen } from "./NewScreen";', "src/ui/NewScreen.test.tsx:2: NewScreen();"]);
    const wired = stagedRepo({ "src/ui/App.tsx": "export const App = 1;\n" }, {
      "src/ui/NewScreen.tsx": screen,
      "src/ui/App.tsx": 'import { NewScreen } from "./NewScreen";\nexport const App = () => <NewScreen />;\n',
    }, UX);
    const quiet: Call[] = [];
    await jevNotes(wired, changes(wired), { env: KEY, post: answering(quiet) });
    expect(quiet.filter((c) => c.body.state.file === "src/ui/NewScreen.tsx").map((c) => Object.keys(c.body.questions)).flat()).not.toContain("feature_not_wired");
  }, 60_000);

  test("untranslated_text is asked on dictionary files only", async () => {
    const o = stagedRepo({ "src/i18n/de.ts": "export const de = {};\n", "src/ui/Save.tsx": "export const x = 1;\n" }, {
      "src/i18n/de.ts": 'export const de = {\n  save: "Save changes",\n};\n',
      "src/ui/Save.tsx": 'export const x = 1;\nexport const label = "Save changes";\n',
    }, UX);
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    const byFile = Object.fromEntries(calls.map((c) => [c.body.state.file, Object.keys(c.body.questions)]));
    expect(byFile["src/i18n/de.ts"]).toContain("untranslated_text");
    expect(byFile["src/ui/Save.tsx"] ?? []).not.toContain("untranslated_text");
  }, 60_000);

  test("ux_off switches questions off; an unknown id is one not-available line", async () => {
    const o = oneFile(SCREEN, '<div className="bg-[#ff0000]" />', `${UX}\nux_off = ["hardcoded_color"]`);
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(asked(calls).flat()).not.toContain("hardcoded_color");
    const bad = oneFile(SCREEN, '<div className="bg-[#ff0000]" />', `${UX}\nux_off = ["colour"]`);
    expect(await jevNotes(bad, changes(bad), { env: KEY, post: answering([]) })).toEqual(["jev: not available (unknown review.ux_off id(s) colour)"]);
  }, 60_000);
});

const AGENT = 'agent_globs = ["agent/**/*.ts"]\nagent_prompt_globs = ["agent/prompts/**/*.md"]\nchange_untested = false\nspec_incomplete = false';

describe("jev agent pack", () => {
  // [question, file, added lines]: each must trigger its question.
  const cases: [string, string, string][] = [
    ["silent_failure", "agent/reply.ts", "try { await send(chat, text); } catch { return null; }"],
    ["unbounded_turn", "agent/loop.ts", "while (true) { await step(); }"],
    ["secrets_in_logs", "agent/log.ts", "console.error(JSON.stringify(process.env));"],
    ["update_without_rollback", "agent/runtime.ts", 'await symlink(next, "current");'],
    ["update_without_rollback", "agent/update.ts", "await swap(next);"],
    ["event_without_dedup", "agent/inbox.ts", "const id = update.message_id; await handle(update);"],
    ["state_overwrite_instead_of_append", "agent/memory.ts", "await writeFile(notesPath, summary);"],
    ["prompt_depends_on_environment", "agent/prompts/night.md", "Read the rules in docs/rules.md before you start."],
    ["prompt_depends_on_environment", "agent/turn.ts", "const prompt = `Use the skill ${name}`;"],
    ["per_vendor_branch", "agent/turn.ts", 'if (provider === "claude") retries = 3;'],
    ["user_text_quality", "agent/chat.ts", "await sendMessage(chat, `Failed: ${err.stack}`);"],
  ];
  for (const [id, file, added] of cases) {
    test(`${id} in ${file}: its trigger asks it; the note has file, line and meaning`, async () => {
      await expectAsked(oneFile(file, added, AGENT, "\n"), id, file);
    }, 60_000);
  }

  test("provider files may branch on a provider; files outside agent_globs are not asked", async () => {
    const calls: Call[] = [];
    const own = oneFile("agent/providers.ts", 'if (provider === "claude") retries = 3;', AGENT, "\n");
    await jevNotes(own, changes(own), { env: KEY, post: answering(calls) });
    expect(asked(calls).flat()).not.toContain("per_vendor_branch");
    const outside = oneFile("lib/loop.ts", "while (true) { await step(); }", AGENT, "\n");
    const none: Call[] = [];
    await jevNotes(outside, changes(outside), { env: KEY, post: answering(none) });
    expect(none).toEqual([]);
  }, 60_000);

  test("agent_off switches questions off; an unknown id is one not-available line", async () => {
    const o = oneFile("agent/loop.ts", "while (true) { await step(); }", `${AGENT}\nagent_off = ["unbounded_turn"]`, "\n");
    const calls: Call[] = [];
    await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    expect(asked(calls).flat()).not.toContain("unbounded_turn");
    const bad = oneFile("agent/loop.ts", "while (true) {}", `${AGENT}\nagent_off = ["loops"]`, "\n");
    expect(await jevNotes(bad, changes(bad), { env: KEY, post: answering([]) })).toEqual(["jev: not available (unknown review.agent_off id(s) loops)"]);
  }, 60_000);
});

const PROJECT_Q = `change_untested = false
spec_incomplete = false
[[review.jev_questions]]
id = "raw_sql"
files = ["src/**/*.ts"]
trigger = "\\\\b(?:SELECT|INSERT|UPDATE|DELETE)\\\\b"
instructions = "Does the code added in \`source_hunk\` build an SQL statement by string concatenation instead of the project's query builder?"
criteria = { true = "An added SQL statement is concatenated or interpolated from values.", false = "SQL goes through the query builder or bound parameters." }
note = "SQL is built by hand"
threshold = 0.6`;

describe("jev project questions", () => {
  test("a [[review.jev_questions]] entry is asked when its glob and trigger match, with its own threshold", async () => {
    const o = oneFile("src/db.ts", "const q = `SELECT * FROM t WHERE id = ${id}`;", PROJECT_Q);
    const calls: Call[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY, post: answering(calls, { raw_sql: { noul: 0.6 } }) });
    expect(asked(calls)).toEqual([["raw_sql"]]);
    expect(calls[0].body.questions.raw_sql.criteria.true).toBe("An added SQL statement is concatenated or interpolated from values.");
    expect(notes(lines)).toEqual(["note: jev raw_sql p=0.60 >= 0.6  src/db.ts:+2  SQL is built by hand"]);
    expect(logOf(o.repo).map((r) => [r.question, r.noted])).toEqual([["raw_sql", true]]);
  }, 60_000);

  test("no trigger match, another file or a test file: not asked", async () => {
    const calls: Call[] = [];
    for (const [file, added] of [["src/db.ts", "const n = 1;"], ["lib/db.ts", "const q = `SELECT 1`;"], ["src/db.test.ts", "const q = `SELECT 1`;"]]) {
      const o = oneFile(file, added, PROJECT_Q);
      await jevNotes(o, changes(o), { env: KEY, post: answering(calls) });
    }
    expect(asked(calls).flat()).not.toContain("raw_sql");
  }, 60_000);

  const broken: [string, string][] = [
    ['id = "textual_test"\nfiles = ["src/**"]\ninstructions = "q?"\ncriteria = { true = "y", false = "n" }\nnote = "n"', "review.jev_questions[0]: id textual_test must be snake_case and unique among all Jev questions"],
    ['id = "x"\nfiles = ["src/**"]\ninstructions = "q?"\ncriteria = { true = "y" }\nnote = "n"', "review.jev_questions[0].criteria: false must be a non-empty string"],
    ['id = "x"\nfiles = ["src/**"]\ntrigger = "("\ninstructions = "q?"\ncriteria = { true = "y", false = "n" }\nnote = "n"', "review.jev_questions[0]: trigger is not a regular expression"],
    ['id = "x"\nfiles = []\ninstructions = "q?"\ncriteria = { true = "y", false = "n" }\nnote = "n"', "review.jev_questions[0]: files must be a non-empty list of globs"],
  ];
  for (const [entry, reason] of broken) {
    test(`a malformed entry is one not-available line: ${reason.split(": ")[1]}`, async () => {
      const o = oneFile("src/db.ts", "const q = 1;", `change_untested = false\n[[review.jev_questions]]\n${entry}`);
      const lines = await jevNotes(o, changes(o), { env: KEY, post: answering([]) });
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith(`jev: not available (${reason}`)).toBe(true);
    }, 60_000);
  }
});
