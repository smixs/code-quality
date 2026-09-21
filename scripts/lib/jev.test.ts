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

const review = (over: Record<string, string> = {}) => ({ ...DEFAULTS.review, ...over }) as Record<string, string | number | boolean>;
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
    test(`${provider}: one request with the documented body, the answered model is logged`, async () => {
      const o = jevRepo();
      const calls: Call[] = [];
      const lines = await jevNotes(o, changes(o), { env, post: postWith(stubFetch(calls, 200, `${model}-answered`)) });
      expect(calls.map((c) => [c.url, c.body.model, Object.keys(c.body.state).sort()])).toEqual([[url, model, ["added_test_code", "diff_hunk", "file"]]]);
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
