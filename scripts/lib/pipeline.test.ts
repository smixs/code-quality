// Behaviour of the pure seams (diff parser, commit-msg, config, push ranges) and two repo-level
// checks on a throwaway git repo. Run: bun test scripts/
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpts, DEFAULTS, loadToml, readArgs } from "./config.ts";
import { runTests, type Tests } from "./crap.ts";
import { changes, parseDiff } from "./diff.ts";
import { gate, type Analysis } from "./gate.ts";
import { PREV_KEY, pushRanges, redAnswer, runCheck } from "./hooks.ts";
import { jevNotes, type Post } from "./jev.ts";
import { failCount } from "./report.ts";
import { commitMsgFindings, docCheck } from "./text.ts";

const SCRIPT = join(import.meta.dir, "../quality.ts");
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "qg-test-"));
  dirs.push(d);
  return d;
};
const testHome = join(tmp(), "code-quality-home");
process.env.CODE_QUALITY_HOME = testHome;
const testEnv = { ...process.env, CODE_QUALITY_HOME: testHome };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: testEnv });
const noGlossary = { toml: DEFAULTS } as never;
const KEY_ENV = { OPENROUTER_API_KEY: "k" };

describe("parseDiff", () => {
  test("numbers added lines from the hunk start", () => {
    const d = parseDiff("+++ b/a.ts\n@@ -1,0 +3,2 @@\n+x\n+y\n").get("a.ts")!;
    expect([...d.added]).toEqual([[3, "x"], [4, "y"]]);
  });
  test("a pure deletion touches both neighbours and adds nothing", () => {
    const d = parseDiff("+++ b/a.ts\n@@ -5,2 +4,0 @@\n-x\n-y\n").get("a.ts")!;
    expect([...d.touched].sort()).toEqual([4, 5]);
    expect(d.added.size).toBe(0);
  });
  test("git changes preserves a non-ASCII path and an unknown patch path fails closed", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/データ.ts"), "export const value = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "src/データ.ts"), "export const value = 2;\n");
    const o = buildOpts(readArgs(["check", "--repo", repo, "--base", "HEAD", "--no-deps"]));
    expect(changes(o).has("src/データ.ts")).toBe(true);
    expect(() => parseDiff('+++ "not-a-git-path"\n')).toThrow("unparsed git diff path");
  });
});

describe("commit-msg", () => {
  test("blocks a Co-Authored-By tool trailer", () => {
    const f = commitMsgFindings(noGlossary, "fix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    expect(f.map((x) => x.line)).toContain(3);
  });
  test("product wording and the -v diff below the scissors pass", () => {
    const msg = "provider: sign in with codex subscription tokens\n# ------------------------ >8 ------------------------\n+// Generated with Claude\n";
    expect(commitMsgFindings(noGlossary, msg)).toEqual([]);
  });
});

describe("config", () => {
  test("an unknown key fails with its name", () => {
    const f = join(tmp(), "q.toml");
    writeFileSync(f, "[thresholds]\nmax_ccc = 3\n");
    expect(() => loadToml(f)).toThrow("max_ccc");
  });
  test("a worktree without .quality.toml reads the main checkout's", () => {
    const repo = tmp();
    sh(repo, "git init -q && git commit -q --allow-empty -m init && git worktree add -q wt");
    writeFileSync(join(repo, ".quality.toml"), "[thresholds]\nmax_cc = 7\n");
    const wt = join(repo, "wt");
    expect(buildOpts(readArgs(["--repo", wt])).toml.thresholds.max_cc).toBe(7);
  });
  test("accepts an empty or listed project.language and rejects an unknown language at load time", () => {
    const dir = tmp();
    const listed = join(dir, "listed.toml");
    const automatic = join(dir, "auto.toml");
    const bad = join(dir, "bad.toml");
    writeFileSync(listed, '[project]\nlanguage = ["go", "rust"]\n');
    writeFileSync(automatic, '[project]\nlanguage = []\n');
    writeFileSync(bad, '[project]\nlanguage = ["go", "brainfuck"]\n');
    expect(loadToml(listed).project.language).toEqual(["go", "rust"]);
    expect(loadToml(automatic).project.language).toEqual([]);
    expect(() => loadToml(bad)).toThrow("unknown project.language brainfuck");
  });
});

describe("CRAP diagnostics", () => {
  test("a repo mean above the warning threshold and growing does not fail the gate", () => {
    const repo = tmp();
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const o = buildOpts(readArgs(["--repo", repo, "--no-deps"]));
    mkdirSync(join(repo, ".scratch/quality"), { recursive: true });
    writeFileSync(o.baseline, JSON.stringify({
      head: "base",
      mean: 5.16,
      functions: { "a.ts::a": { line: 1, cc: 1, crap: 5.33 } },
      deps: null,
      knip: [],
      tools: [],
    }));
    const tests: Tests = { lcov: "", code: 0, failed: 0, skipped: false, red: false, used: true };
    const a = {
      ch: new Map(), tests,
      fns: [{ file: "a.ts", name: "a", key: "a.ts::a", start: 1, end: 1, col: 0, nested: [], cc: 1, cov: 1, crap: 5.33 }],
      failed: [], checks: [], deps: null, knip: null, adapterTools: [], adapterAudit: true, docsOnly: false,
    } as unknown as Analysis;
    const result = gate(o, a);
    expect(failCount(result.checks)).toBe(0);
    expect(result.drift).toEqual(["note: crap/mean: 5.33 (baseline 5.16, +0.17)"]);
  });
});

describe("pushRanges", () => {
  test("an update pushes remote..local, a branch delete pushes nothing", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const z = "0".repeat(40);
    expect(pushRanges({ repo: "/", base: "origin/main" } as never, `refs/heads/x ${a} refs/heads/x ${b}\nrefs/heads/y ${z} refs/heads/y ${a}\n`)).toEqual([`${b}..${a}`]);
  });
  test("the first push of a root commit without origin/main diffs from the empty tree", () => {
    const repo = tmp();
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const head = sh(repo, "git rev-parse HEAD").stdout.trim();
    const [range] = pushRanges({ repo, base: "origin/main" } as never, `HEAD ${head} refs/heads/main ${"0".repeat(40)}\n`);
    expect(sh(repo, `git diff --name-only ${range}`).stdout.trim()).toBe("a.ts");
  });
  test("the first commit of a fresh repo is judged from the empty tree, not refused", async () => {
    const repo = tmp();
    const ifs = Array.from({ length: 11 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
    writeFileSync(join(repo, "a.ts"), `export function a(x: number) {\n${ifs}\n  return -1;\n}\n`);
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    sh(repo, "git init -q && git add -A");
    const red = await runCheck(buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"])));
    expect([red.ok, /complexity 12 > 10/.test(red.text)]).toEqual([false, true]);
  }, 60_000);
});

describe("docs", () => {
  test("a missing symbol fails in a guide and passes in an ADR", () => {
    const repo = tmp();
    mkdirSync(join(repo, "docs/adr"), { recursive: true });
    writeFileSync(join(repo, "a.ts"), "export const keptName = 1;\n");
    writeFileSync(join(repo, "docs/guide.md"), "Call `goneName` and `keptName`.\n");
    writeFileSync(join(repo, "docs/adr/0001-x.md"), "`goneName` was removed.\n");
    sh(repo, "git init -q && git add -A");
    const o = buildOpts(readArgs(["--repo", repo, "--all"]));
    const found = docCheck(o, changes(o)).findings.map((f) => `${f.rule} ${f.file}`);
    expect(found).toEqual(["doc/symbol docs/guide.md"]);
  });
});

describe("agent-stop", () => {
  test("a session that changed nothing gets {} without a verdict; a dirty src path is judged", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/k.ts"), "export const k = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const stop = () => spawnSync("bun", [SCRIPT, "agent-stop", "--no-deps"], { input: JSON.stringify({ cwd: repo, session_id: "s1" }), encoding: "utf8", env: testEnv });
    expect([stop().stdout.trim(), existsSync(join(repo, ".scratch/quality/check.md"))]).toEqual(["{}", false]);
    const ifs = Array.from({ length: 11 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
    writeFileSync(join(repo, "src/a.ts"), `export function a(x: number) {\n${ifs}\n  return -1;\n}\n`);
    sh(repo, "git add src/a.ts");
    expect(JSON.parse(stop().stdout).decision).toBe("block");
    const camel = spawnSync("bun", [SCRIPT, "agent-stop", "--no-deps"], { input: JSON.stringify({ cwd: repo, sessionId: "camel" }), encoding: "utf8", env: testEnv });
    expect(JSON.parse(camel.stdout).decision).toBe("block");
  }, 120_000);
  test("a Jev note that changes between two Stops does not block a second time; a new red verdict does", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[review]\njev = true\n');
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/k.ts"), "export const k = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const ifs = (n: number) => Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
    writeFileSync(join(repo, "src/a.ts"), `export function a(x: number) {\n  if (x < 0) throw new Error("neg");\n${ifs(11)}\n  return -1;\n}\n`);
    writeFileSync(join(repo, "src/a.test.ts"), 'import { test } from "node:test";\ntest("t", () => {});\n');
    sh(repo, "git add -A");
    const o = buildOpts(readArgs(["--repo", repo, "--no-deps"]));
    const stopState = { repo, outDir: o.outDir };
    const timeout: Post = async () => {
      throw new Error("timeout");
    };
    const answer: Post = async () => ({ status: 200, text: JSON.stringify({ answers: { textual_test: { type: "noul", noul: 0.9 }, error_path_tested: { type: "noul", noul: 0.1 } } }) });
    const first = await runCheck(o, { env: KEY_ENV, post: timeout });
    const second = await runCheck(o, { env: KEY_ENV, post: answer });
    expect([first.ok, first.text === second.text]).toEqual([false, false]);
    expect([redAnswer(stopState, "s", first), redAnswer(stopState, "s", second)].map((r) => Object.keys(r)[0])).toEqual(["decision", "systemMessage"]);
    writeFileSync(join(repo, "src/a.ts"), `export function a(x: number) {\n${ifs(14)}\n  return -1;\n}\n`);
    expect(redAnswer(stopState, "s", await runCheck(o, { env: KEY_ENV, post: answer }))).toHaveProperty("decision", "block");
  }, 120_000);
  test("stdin that is not JSON is an error with JSON output (exit 1), not an allow", () => {
    const r = spawnSync("bun", [SCRIPT, "agent-stop"], { input: "garbage", encoding: "utf8", env: testEnv });
    expect([r.status, JSON.parse(r.stdout).systemMessage]).toEqual([1, "code-quality Stop hook received invalid JSON input"]);
  });
  test("missing session id is an explicit JSON error", () => {
    const r = spawnSync("bun", [SCRIPT, "agent-stop"], { input: JSON.stringify({ cwd: tmp() }), encoding: "utf8", env: testEnv });
    expect([r.status, JSON.parse(r.stdout).systemMessage]).toEqual([1, "code-quality Stop hook failed: missing session_id/sessionId"]);
  });
});

describe("install-hooks chains the repo's own hooks", () => {
  const commit = (repo: string) => sh(repo, "git -c user.name=t -c user.email=t@t commit -q --no-verify --allow-empty -m c");
  const hook = (dir: string, name: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  const q = (...args: string[]) => spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env: testEnv });

  test(".git/hooks: post-commit runs, pre-push gets the refs on stdin and its failure stops the push", () => {
    const repo = tmp();
    const remote = tmp();
    sh(remote, "git init -q --bare");
    sh(repo, `git init -q && git remote add origin ${remote}`);
    commit(repo);
    hook(join(repo, ".git/hooks"), "post-commit", "touch .git/post-commit-ran");
    hook(join(repo, ".git/hooks"), "pre-push", 'cat > .git/pushed; echo "$1" >> .git/pushed');
    expect(q("install-hooks", repo).stdout).toContain("post-commit, pre-push");
    commit(repo);
    const push = sh(repo, "git push -q origin HEAD:refs/heads/main");
    const pushed = readFileSync(join(repo, ".git/pushed"), "utf8");
    expect([existsSync(join(repo, ".git/post-commit-ran")), push.status, / [0-9a-f]{40} refs\/heads\/main 0{40}\n/.test(pushed), pushed.trim().endsWith("origin")]).toEqual([true, 0, true, true]);
    hook(join(repo, ".git/hooks"), "pre-push", "exit 3");
    commit(repo);
    expect(sh(repo, "git push -q origin HEAD:refs/heads/main").status).not.toBe(0);
  }, 120_000);

  test("a previous core.hooksPath (husky) is chained and restored by uninstall-hooks", () => {
    const repo = tmp();
    sh(repo, "git init -q && git config core.hooksPath .husky");
    hook(join(repo, ".husky"), "post-commit", "touch husky-ran");
    q("install-hooks", repo);
    expect(sh(repo, `git config --get ${PREV_KEY}`).stdout.trim()).toBe(".husky");
    commit(repo);
    expect(existsSync(join(repo, "husky-ran"))).toBe(true);
    q("uninstall-hooks", repo);
    expect([sh(repo, "git config --get core.hooksPath").stdout.trim(), sh(repo, `git config --get ${PREV_KEY}`).status]).toEqual([".husky", 1]);
  }, 60_000);

  test("a --global core.hooksPath is chained; uninstall without our hooks drops a stale previous path", () => {
    const repo = tmp();
    const g = join(tmp(), "gitconfig");
    writeFileSync(g, `[core]\n\thooksPath = ${join(repo, "global-hooks")}\n`);
    sh(repo, "git init -q");
    hook(join(repo, "global-hooks"), "post-commit", "touch global-ran");
    q("install-hooks", repo);
    sh(repo, `GIT_CONFIG_GLOBAL=${g} git -c user.name=t -c user.email=t@t commit -q --no-verify --allow-empty -m c`);
    expect(existsSync(join(repo, "global-ran"))).toBe(true);
    sh(repo, `git config core.hooksPath .husky/_ && git config ${PREV_KEY} .husky`);
    expect(q("uninstall-hooks", repo).stdout).toContain("stale");
    expect([sh(repo, "git config --get core.hooksPath").stdout.trim(), sh(repo, `git config --get ${PREV_KEY}`).status]).toEqual([".husky/_", 1]);
  }, 60_000);
});

describe("check", () => {
  test("an older red full run is reported but cannot fail a docs-only check", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "README.md"), "before\n");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".quality.toml"), `[project]
language = "ts"
src = ["src"]
base = "HEAD"
test_cmd = '(printf "TN:\\n" > "$QG_LCOV"; printf " 1 fail\\n"; exit 1)'
`);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const o = buildOpts(readArgs(["check", "--repo", repo, "--no-deps"]));
    mkdirSync(o.out, { recursive: true });
    expect(runTests(o, "run").failed).toBe(1);
    writeFileSync(join(repo, "README.md"), "after\n");
    const result = await runCheck(o);
    const head = sh(repo, "git rev-parse HEAD").stdout.trim().slice(0, 8);
    expect([result.ok, result.text]).toEqual([true, expect.stringMatching(new RegExp(`^tests: not run \\(last full run .+, ${head}\\)`, "m"))]);
  }, 120_000);

  test("a docs-only change does not invoke deps or knip and declares its scope", async () => {
    const repo = tmp();
    const bin = join(repo, "bin");
    const calls = join(repo, "npx-calls");
    mkdirSync(join(repo, "src"));
    mkdirSync(bin);
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
    writeFileSync(join(repo, "package.json"), '{"name":"docs-only","private":true}\n');
    writeFileSync(join(repo, "README.md"), "before\n");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(bin, "npx"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$QG_PROBE_LOG"\nexit 1\n');
    chmodSync(join(bin, "npx"), 0o755);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "README.md"), "after\n");
    const result = spawnSync(process.execPath, [SCRIPT, "check", "--repo", repo], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, QG_PROBE_LOG: calls },
    });
    expect([result.status, result.stdout.includes("scope: docs-only"), existsSync(calls)]).toEqual([0, true, false]);
  }, 120_000);

  test("without a baseline old cycles and knip entries are notes while new debt still fails", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const o = buildOpts(readArgs(["check", "--repo", repo]));
    const tests: Tests = { lcov: "", code: 0, failed: null, skipped: true, red: false, used: false };
    const a = {
      ch: new Map(), tests, fns: [], failed: [], checks: [],
      deps: { error: "", cycles: [{ key: "a|b", text: "a -> b" }, { key: "c|d", text: "c -> d" }], layers: [] },
      knip: { error: "", counts: {}, files: [], exports: ["src/a.ts:oldExport", "src/a.ts:newExport"] },
    } as unknown as Analysis;
    const baseDebt = {
      deps: { error: "", cycles: [{ key: "a|b", text: "a -> b" }], layers: [] },
      knip: { error: "", counts: {}, files: [], exports: ["src/a.ts:oldExport"] },
    };
    const result = gate(o, a, baseDebt);
    const findings = result.checks.flatMap((item) => item.findings.map((f) => f.msg));
    const notices = result.checks.flatMap((item) => item.notices);
    expect(findings).toEqual(["new import cycle: c -> d", "new unused export src/a.ts:newExport"]);
    expect(notices).toEqual(["baseline: missing, run --update-baseline; 1 cycles / 1 knip entries not judged"]);
  });

  test("a repo without a baseline compares its existing cycle with project.base", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
    writeFileSync(join(repo, "package.json"), '{"name":"missing-baseline","private":true,"type":"module"}\n');
    writeFileSync(join(repo, "src/a.ts"), 'import { b } from "./b.ts";\nexport const a = b + 1;\n');
    writeFileSync(join(repo, "src/b.ts"), 'import { a } from "./a.ts";\nexport const b = a + 1;\n');
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "src/a.ts"), 'import { b } from "./b.ts";\nexport const a = b + 2;\n');
    const result = await runCheck(buildOpts(readArgs(["check", "--repo", repo])));
    expect([result.ok, result.text]).toEqual([true, expect.stringContaining("baseline: missing, run --update-baseline; 1 cycles")]);
  }, 120_000);

  test("failed test counts are summed across bun test buckets", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".quality.toml"), `[project]
language = "ts"
src = ["src"]
base = "HEAD"
test_cmd = '(printf "TN:\\n" > "$QG_LCOV"; printf " 0 fail\\n 2 fail\\n"; exit 1)'
`);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const o = buildOpts(readArgs(["--repo", repo, "--no-deps"]));
    mkdirSync(o.out, { recursive: true });
    const result = runTests(o, "run");
    expect([result.code, result.failed]).toEqual([1, 2]);
  });

  test("a function over the bar and a dead doc path turn the gate red; the fix turns it green", async () => {
    const repo = tmp();
    const ifs = Array.from({ length: 11 }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n");
    writeFileSync(join(repo, "a.ts"), `export function a(x: number) {\n${ifs}\n  return -1;\n}\n`);
    writeFileSync(join(repo, "README.md"), "See `lib/gone.ts`.\n");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib/kept.ts"), "export const k = 1;\n");
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const opts = () => buildOpts(readArgs(["--repo", repo, "--all", "--no-deps"]));
    const red = await runCheck(opts());
    expect([red.ok, /complexity 12 > 10/.test(red.text), /lib\/gone\.ts. does not exist/.test(red.text)]).toEqual([false, true, true]);
    writeFileSync(join(repo, "a.ts"), "export const a = (x: number) => x;\n");
    writeFileSync(join(repo, "README.md"), "See `lib/kept.ts`.\n");
    const green = await runCheck(opts());
    expect([green.ok, green.text.split("\n")[1]]).toEqual([true, "GATE PASS"]);
  }, 120_000);

  test("writes accepted bypasses to the Bypasses section in Markdown and JSON", async () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, "src/value.test.ts"), 'test("value", () => {});\n');
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 2;\n");
    rmSync(join(repo, "src/value.test.ts"));
    mkdirSync(join(repo, ".scratch/quality"), { recursive: true });
    writeFileSync(join(repo, ".scratch/quality/allow.md"), "qg:test-removed obsolete case\n");
    sh(repo, "git add -A");
    const o = buildOpts(readArgs(["check", "--repo", repo, "--staged", "--no-deps"]));
    expect((await runCheck(o)).ok).toBe(true);
    const md = readFileSync(join(repo, ".scratch/quality/check.md"), "utf8");
    const json = JSON.parse(readFileSync(join(repo, ".scratch/quality/check.json"), "utf8"));
    expect(md).toContain("## Bypasses\n- note: bypass tamper/test-deleted allow.md obsolete case");
    expect(json.bypasses).toContain("note: bypass tamper/test-deleted allow.md obsolete case");
  }, 120_000);

  test("full gate analyzes all source after a docs-only HEAD commit", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "README.md"), "before\n");
    writeFileSync(join(repo, "src/value.ts"), "export function value(x: number) {\n  return x + 1;\n}\n");
    writeFileSync(join(repo, "coverage.lcov"), `TN:\nSF:${join(repo, "src/value.ts")}\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record\n`);
    writeFileSync(join(repo, ".quality.toml"), `[project]
language = "ts"
src = ["src"]
base = "HEAD~1"
test_cmd = 'cp coverage.lcov "$QG_LCOV"'

[security]
gitleaks = false
audit = false
`);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "README.md"), "after\n");
    sh(repo, "git add README.md && git -c user.name=t -c user.email=t@t commit -qm docs");
    const run = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--no-deps"], { encoding: "utf8", env: testEnv });
    const report = readFileSync(join(repo, ".scratch/quality/report.md"), "utf8");
    expect([run.status, report.includes("scope all"), report.includes("functions 1,")]).toEqual([0, true, true]);
  }, 120_000);

  test("update-baseline refuses zero functions without touching the existing file", () => {
    const repo = tmp();
    const baseline = join(repo, "baseline.json");
    const original = '{"sentinel":"keep"}\n';
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".quality.toml"), `[project]
language = "ts"
src = ["src"]
base = "HEAD"
test_cmd = '(printf "TN:\\n" > "$QG_LCOV")'

[security]
gitleaks = false
audit = false
`);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(baseline, original);
    const run = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--no-deps", "--update-baseline", "--baseline", baseline], { encoding: "utf8", env: testEnv });
    expect([run.status, run.stdout, readFileSync(baseline, "utf8")]).toEqual([
      1,
      expect.stringContaining("baseline not written: 0 functions found for non-empty project.src"),
      original,
    ]);
  }, 120_000);

  test("full gate prints skipped security notices", () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, "coverage.lcov"), `TN:\nSF:${join(repo, "src/value.ts")}\nDA:1,1\nend_of_record\n`);
    writeFileSync(join(repo, ".quality.toml"), `[project]
language = "ts"
src = ["src"]
base = "HEAD"
test_cmd = 'cp coverage.lcov "$QG_LCOV"'

[security]
audit = false
`);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    const run = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--no-deps"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect([run.status, run.stdout.includes("secret/gitleaks: not installed")]).toEqual([0, true]);
  }, 120_000);
});

// Jev is injected: no network. Staged change = code adds a throw, a new test reads a source file's text.
describe("jev notes", () => {
  // change_untested is off here: these tests hold the test-hunk questions alone (jev.test.ts has the rest).
  const jevRepo = () => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[review]\njev = true\nchange_untested = false\n');
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/a.ts"), "export const a = (x: number) => x;\n");
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "src/a.ts"), 'export const a = (x: number) => {\n  if (x < 0) throw new Error("negative");\n  return x;\n};\n');
    writeFileSync(join(repo, "src/a.test.ts"), 'import { readFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("t", () => { readFileSync("src/a.ts", "utf8").includes("throw"); });\n');
    sh(repo, "git add -A");
    return buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"]));
  };
  const answering = (textual: number, errorPath: number, bodies: unknown[] = []): Post => async (_target, body) => {
    bodies.push(body);
    return { status: 200, text: JSON.stringify({ answers: { textual_test: { type: "noul", noul: textual }, error_path_tested: { type: "noul", noul: errorPath } } }) };
  };

  type NewQuestion = {
    id: "assertion_weakened" | "mock_hides_behavior" | "property_is_tautology";
    before: string;
    after: string;
    stateFields: string[];
  };
  const newQuestions: NewQuestion[] = [
    {
      id: "assertion_weakened",
      before: 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
      after: 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBeDefined());\n',
      stateFields: ["file", "test_hunk"],
    },
    {
      id: "mock_hides_behavior",
      before: 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
      after: 'import { test, expect, vi } from "bun:test";\nvi.mock("./a", () => ({ a: () => 1 }));\ntest("a", () => expect(1).toBe(1));\n',
      stateFields: ["file", "changed_source_files", "test_hunk"],
    },
    {
      id: "property_is_tautology",
      before: 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
      after: 'import { test } from "bun:test";\nimport fc from "fast-check";\ntest("a", () => fc.assert(fc.property(fc.integer(), (x) => x + 1 === x + 1)));\n',
      stateFields: ["file", "test_hunk"],
    },
  ];
  const questionRepo = (q: NewQuestion) => {
    const repo = tmp();
    mkdirSync(join(repo, "src"));
    const toggles = newQuestions.map((x) => `${x.id} = ${x.id === q.id}`).join("\n");
    writeFileSync(join(repo, ".quality.toml"), `[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n[review]\njev = true\nchange_untested = false\ntextual_test = false\nerror_path_tested = false\n${toggles}\n`);
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "src/a.ts"), "export const a = (x: number) => x;\n");
    writeFileSync(join(repo, "src/a.test.ts"), q.before);
    sh(repo, "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    writeFileSync(join(repo, "src/a.ts"), "export const a = (x: number) => x + 1;\n");
    writeFileSync(join(repo, "src/a.test.ts"), q.after);
    sh(repo, "git add -A");
    return buildOpts(readArgs(["--repo", repo, "--staged", "--no-deps"]));
  };
  const answerQuestion = (id: NewQuestion["id"], p: number, bodies: unknown[] = []): Post => async (_target, body) => {
    bodies.push(body);
    return { status: 200, text: JSON.stringify({ answers: { [id]: { type: "noul", noul: p } } }) };
  };

  test("textual_test at or above 0.85 and error_path_tested below 0.5 are notes; both questions go in one request; verdicts are logged", async () => {
    const o = jevRepo();
    const bodies: unknown[] = [];
    const lines = await jevNotes(o, changes(o), { env: KEY_ENV, post: answering(0.93, 0.2, bodies) });
    expect(lines.filter((l) => l.startsWith("note: jev")).map((l) => l.split(" ")[2])).toEqual(["textual_test", "error_path_tested"]);
    expect(bodies.map((b) => Object.keys((b as { questions: object }).questions))).toEqual([["textual_test", "error_path_tested"]]);
    const log = readFileSync(join(o.repo, ".scratch/quality/jev-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.map((r) => [r.question, r.p, r.file])).toEqual([["textual_test", 0.93, "src/a.test.ts"], ["error_path_tested", 0.2, "src/a.test.ts"]]);
    const quiet = await jevNotes(o, changes(o), { env: KEY_ENV, post: answering(0.84, 0.5) });
    expect(quiet.filter((l) => l.startsWith("note:"))).toEqual([]);
  }, 60_000);

  test("a missing key is one 'not available' line and no request", async () => {
    const o = jevRepo();
    const bodies: unknown[] = [];
    expect(await jevNotes(o, changes(o), { env: {}, post: answering(1, 0, bodies) })).toEqual(["jev: not available (no TYPESAFE_API_KEY or OPENROUTER_API_KEY)"]);
    expect(bodies).toEqual([]);
  }, 60_000);

  test("a failing Jev call leaves the verdict to the deterministic checks", async () => {
    const o = jevRepo();
    const broken: Post = async () => {
      throw new Error("connection refused");
    };
    const r = await runCheck(o, { env: KEY_ENV, post: broken });
    expect([r.ok, r.text.split("\n").filter((l) => l.startsWith("jev: not available"))]).toEqual([true, ["jev: not available (connection refused)"]]);
    const http500: Post = async () => ({ status: 500, text: "upstream" });
    expect((await runCheck(o, { env: KEY_ENV, post: http500 })).ok).toBe(true);
  }, 120_000);

  for (const q of newQuestions) {
    test(`${q.id}: p at the threshold creates a note with the question's minimal state`, async () => {
      const o = questionRepo(q);
      const bodies: unknown[] = [];
      const lines = await jevNotes(o, changes(o), { env: KEY_ENV, post: answerQuestion(q.id, 0.7, bodies) });
      expect(lines.filter((l) => l.startsWith("note: jev")).map((l) => l.split(" ")[2])).toEqual([q.id]);
      const body = bodies[0] as { questions: object; state: Record<string, unknown> };
      expect([bodies.length, Object.keys(body.questions), Object.keys(body.state).sort()]).toEqual([1, [q.id], q.stateFields.toSorted()]);
      if (q.id === "assertion_weakened") expect(String(body.state.test_hunk)).toMatch(/^-.*\n\+/m);
      if (q.id === "mock_hides_behavior") expect(body.state.changed_source_files).toEqual(["src/a.ts"]);
    }, 60_000);

    test(`${q.id}: p below the threshold is logged but creates no note`, async () => {
      const o = questionRepo(q);
      const lines = await jevNotes(o, changes(o), { env: KEY_ENV, post: answerQuestion(q.id, 0.69) });
      expect(lines.filter((l) => l.startsWith("note: jev"))).toEqual([]);
      const log = readFileSync(join(o.repo, ".scratch/quality/jev-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(log.map((r) => [r.question, r.p, r.noted])).toEqual([[q.id, 0.69, false]]);
    }, 60_000);
  }

  test("mock_hides_behavior also applies to a local stub that shadows an imported source function", async () => {
    const q: NewQuestion = {
      id: "mock_hides_behavior",
      before: 'import { test, expect } from "bun:test";\nimport { a } from "./a.ts";\ntest("a", () => expect(a(1)).toBe(1));\n',
      after: 'import { test, expect } from "bun:test";\nimport { a } from "./a.ts";\ntest("a", async () => {\n  const a = async () => 1;\n  expect(await a()).toBe(1);\n});\n',
      stateFields: ["file", "changed_source_files", "test_hunk"],
    };
    const o = questionRepo(q);
    const bodies: unknown[] = [];
    await jevNotes(o, changes(o), { env: KEY_ENV, post: answerQuestion(q.id, 0.2, bodies) });
    expect(bodies.map((body) => Object.keys((body as { questions: object }).questions))).toEqual([["mock_hides_behavior"]]);
  }, 60_000);

  test("all applicable new questions for one hunk go in one request", async () => {
    const q: NewQuestion = {
      id: "assertion_weakened",
      before: 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
      after: 'import { test, expect, vi } from "bun:test";\nimport fc from "fast-check";\nvi.mock("./a", () => ({ a: () => 1 }));\ntest("a", () => fc.assert(fc.property(fc.integer(), (x) => expect(x).toBeDefined())));\n',
      stateFields: [],
    };
    const o = questionRepo(q);
    o.toml.review.mock_hides_behavior = true;
    o.toml.review.property_is_tautology = true;
    const bodies: unknown[] = [];
    const post: Post = async (_target, body) => {
      bodies.push(body);
      return { status: 200, text: JSON.stringify({ answers: Object.fromEntries(newQuestions.map((x) => [x.id, { type: "noul", noul: 0.1 }])) }) };
    };
    await jevNotes(o, changes(o), { env: KEY_ENV, post });
    expect(bodies.map((body) => Object.keys((body as { questions: object }).questions))).toEqual([newQuestions.map((x) => x.id)]);
  }, 60_000);
});
