// git exports GIT_DIR, GIT_INDEX_FILE, ... to a hook. A test the hook runs must not see them: its
// `git init` in a temp dir would act on the pushed repository (splendor, 26.09: core.bare = true, a
// fixture user in .git/config, the worktree index replaced by fixture files).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./util.ts";

const SCRIPT = join(import.meta.dir, "../quality.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-hook-env-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// This file may itself run under a hook.
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function write(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const FIXTURE_TEST = `import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { value } from "./value.ts";

// No env: the child gets the environment the test process started with, as a real harness does.
const gitIn = (dir: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });

test("a fixture repository in a temp dir", () => {
  const dir = process.env.QG_FIXTURE_DIR!;
  mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.name", "Bootstrap Test");
  writeFileSync(join(dir, "fixture.txt"), "fixture\\n");
  gitIn(dir, "add", "fixture.txt");
  writeFileSync(process.env.QG_FIXTURE_OUT!, gitIn(dir, "rev-parse", "--absolute-git-dir").stdout.toString());
  expect(value).toBe(2);
});
`;

describe("git hook environment", () => {
  test("a pre-push test's git init in a temp dir leaves the pushing worktree's repository alone", () => {
    const repo = join(root, "repo");
    const wt = join(root, "wt");
    const fixture = join(root, "fixture");
    const out = join(root, "fixture-git-dir");
    const env = { ...clean, CODE_QUALITY_HOME: join(root, "home"), QG_FIXTURE_DIR: fixture, QG_FIXTURE_OUT: out };
    const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env });
    mkdirSync(join(root, "remote.git"));
    sh(join(root, "remote.git"), "git init -q --bare");
    write(repo, ".gitignore", ".scratch/\n");
    write(repo, ".quality.toml", '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "origin/main"\n[hooks]\npre_push_test_cmd = "bun test {files}"\n[security]\ngitleaks = false\naudit = false\n');
    write(repo, "src/value.ts", "export const value = 1;\n");
    write(repo, "src/value.test.ts", FIXTURE_TEST);
    const commit = "git add -A && git -c user.name=t -c user.email=t@t commit -qm";
    sh(repo, `git init -q -b main && ${commit} init && git remote add origin ../remote.git && git push -q origin main 2>&1`);
    sh(repo, `git worktree add -q -b feature ${wt}`);
    write(wt, "src/value.ts", "export const value = 2;\n");
    sh(wt, `${commit} change`);
    expect(spawnSync(process.execPath, [SCRIPT, "install-hooks", repo], { encoding: "utf8", env }).status).toBe(0);

    const push = sh(wt, "git push origin HEAD:main 2>&1");
    const config = (key: string) => sh(repo, `git config --local --get ${key}`).stdout.trim();
    expect({
      push: push.status,
      fixtureGitDir: readFileSync(out, "utf8").trim(),
      bare: config("core.bare"),
      user: config("user.name"),
      index: sh(wt, "git ls-files").stdout.trim().split("\n"),
    }).toEqual({
      push: 0,
      fixtureGitDir: join(fixture, ".git"),
      bare: "false",
      user: "",
      index: [".gitignore", ".quality.toml", "src/value.test.ts", "src/value.ts"],
    });
  }, 120_000);

  test("the gate's own git in pre-commit reads the index git hands the hook (git commit -- <path>)", () => {
    const repo = join(root, "partial");
    const env = { ...clean, CODE_QUALITY_HOME: join(root, "home-partial") };
    const sh = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: repo, encoding: "utf8", env });
    write(repo, ".gitignore", ".scratch/\n");
    write(repo, ".quality.toml", '[project]\nbase = "HEAD"\n');
    write(repo, "README.md", "# a\n");
    sh("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init");
    expect(spawnSync(process.execPath, [SCRIPT, "install-hooks", repo], { encoding: "utf8", env }).status).toBe(0);
    write(repo, "README.md", "# a\n\nstaged\n");
    sh("git add README.md");
    write(repo, "README.md", "# a\n\nstaged\n\ncommitted\n");
    // .git/index holds another README.md than the work tree ("partly staged"); the commit's own index does not.
    const commit = sh("git -c user.name=t -c user.email=t@t commit -qm docs -- README.md 2>&1");
    expect([commit.status, commit.stdout]).toEqual([0, expect.not.stringContaining("partly staged")]);
  }, 120_000);

  test("run: git in the hook's work tree keeps git's variables, every other command runs without them", () => {
    const repo = join(root, "vars");
    const other = join(root, "other");
    mkdirSync(repo);
    mkdirSync(other);
    spawnSync("git", ["init", "-q"], { cwd: repo, env: clean });
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_EDITOR: process.env.GIT_EDITOR };
    Object.assign(process.env, { GIT_DIR: join(repo, ".git"), GIT_INDEX_FILE: join(repo, ".git/index"), GIT_EDITOR: ":" });
    try {
      const shell = run("sh", ["-c", 'printf "%s|%s|%s" "$GIT_DIR" "$GIT_INDEX_FILE" "$GIT_EDITOR"'], other).out;
      const hookTree = run("git", ["rev-parse", "--absolute-git-dir"], process.cwd()).out.trim();
      const tempTree = run("git", ["rev-parse", "--absolute-git-dir"], other).code;
      expect([shell, hookTree, tempTree]).toEqual(["||:", join(repo, ".git"), 128]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
