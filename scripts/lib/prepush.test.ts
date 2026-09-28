// pre-push reports on the pushed commit and never stops the push: the touched tests run on the
// checked-out tree, so they run only when that tree is the pushed commit, clean in the files the tests
// read. Red tests are a red flag, first line. Spawned: bun scripts/quality.ts hook pre-push.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADD, ADD_NEG, ADD_TEST, alive, cleanup, commit, git, laneEnv, NEG_TEST, nodeRepo, nodeTest, qualityAsync, read, SCRIPT, SLEEPER, tmp, until, write } from "./testkit.ts";

afterAll(cleanup);

const ZERO = "0".repeat(40);
const RED_NEG = 'test("neg", () => assert.equal(add(-1, 2), 99));';

// A main checkout (green) and a worktree on branch B that changes add and its test.
function twoCheckouts(bTest: string) {
  const main = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST), "README.md": "readme\n" });
  write(main, ".quality.toml", `${read(main, ".quality.toml")}\n[hooks]\npre_push_test_cmd = 'touch started; node --test {files}'\n`);
  commit(main, "hooks");
  const base = git(main, "rev-parse", "HEAD");
  const wt = join(tmp(), "wt-b");
  git(main, "worktree", "add", "-q", wt, "-b", "B");
  write(wt, "src/calc.ts", ADD_NEG);
  write(wt, "src/calc.test.ts", nodeTest(ADD_TEST, bTest));
  commit(wt, "b");
  return { main, wt, base, b: git(wt, "rev-parse", "HEAD") };
}

function push(checkout: string, lines: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, "hook", "pre-push", "--repo", checkout, "--no-deps"], { input: `${lines.join("\n")}\n`, encoding: "utf8", env: laneEnv() });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, started: existsSync(join(checkout, "started")) };
}

// The remote already has the base commit, so the range is base..B.
const branch = (c: { b: string; base: string }) => `refs/heads/B ${c.b} refs/heads/B ${c.base}`;
const wrongTree = (sha: string, head: string) => `pre-push: touched tests not run: pushing ${sha} (refs/heads/B), this checkout is at ${head}; they run on the checked-out tree, push from a checkout of that commit to run them`;

describe("pre-push reports on the pushed commit and lets the push go", () => {
  test("a branch pushed from a checkout at another commit goes, with a note; its tests do not start", () => {
    const c = twoCheckouts(NEG_TEST);
    const r = push(c.main, [branch(c)]);
    expect([r.status, r.out.includes(wrongTree(git(c.main, "rev-parse", "--short", c.b), git(c.main, "rev-parse", "--short", "HEAD"))), r.started]).toEqual([0, true, false]);
  }, 60_000);

  test("a red branch pushed from a green checkout is not reported green", () => {
    const c = twoCheckouts(RED_NEG);
    const r = push(c.main, [branch(c)]);
    expect([r.status, r.out.includes("touched tests not run"), r.out.includes("pass"), r.started]).toEqual([0, true, false, false]);
  }, 60_000);

  test("the same push from the branch's own worktree runs the tests as before", () => {
    const green = twoCheckouts(NEG_TEST);
    const ok = push(green.wt, [branch(green)]);
    expect([ok.status, ok.started, ok.out.includes("pre-push: 1 touched test file(s) pass")]).toEqual([0, true, true]);
    const red = twoCheckouts(RED_NEG);
    const failed = push(red.wt, [branch(red)]);
    expect([failed.status, failed.started, failed.out.includes("pre-push: 1 touched test file(s) exit 1")]).toEqual([0, true, true]);
    expect(failed.out.split("\n")[0]).toStartWith("RED FLAG: pushing with red tests: 1 touched test file(s) exit 1 -- the pushed commit breaks what its own tests check; check: read ");
  }, 60_000);

  test("uncommitted edits in a selected test or a deleted pushed file are named; tests do not run, the push goes", () => {
    const edited = twoCheckouts(NEG_TEST);
    write(edited.wt, "src/calc.test.ts", nodeTest(ADD_TEST));
    const r1 = push(edited.wt, [branch(edited)]);
    expect([r1.status, r1.out.includes("pre-push: touched tests not run: uncommitted changes in files they read: src/calc.test.ts; commit or stash them to run the tests"), r1.started]).toEqual([0, true, false]);
    const deleted = twoCheckouts(NEG_TEST);
    rmSync(join(deleted.wt, "src/calc.ts"));
    const r2 = push(deleted.wt, [branch(deleted)]);
    expect([r2.status, r2.out.includes("files they read: src/calc.ts;"), r2.started]).toEqual([0, true, false]);
  }, 60_000);

  test("an unrelated dirty file does not stop the tests", () => {
    const c = twoCheckouts(NEG_TEST);
    write(c.wt, "README.md", "edited\n");
    write(c.wt, "notes.txt", "scratch\n");
    const r = push(c.wt, [branch(c)]);
    expect([r.status, r.started]).toEqual([0, true]);
  }, 60_000);

  test("a branch plus an annotated tag at HEAD runs the tests", () => {
    const c = twoCheckouts(NEG_TEST);
    git(c.wt, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "v1", "-m", "v1");
    const tag = git(c.wt, "rev-parse", "v1");
    const r = push(c.wt, [branch(c), `refs/tags/v1 ${tag} refs/tags/v1 ${c.base}`]);
    expect([tag !== c.b, r.status, r.started]).toEqual([true, 0, true]);
  }, 60_000);

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${signal} during the pre-push tests kills their process group, exit ${code}`, async () => {
      const c = twoCheckouts(NEG_TEST);
      write(c.wt, ".quality.toml", read(c.wt, ".quality.toml").replace("pre_push_test_cmd = 'touch started; node --test {files}'", `pre_push_test_cmd = '${SLEEPER}'`));
      const run = qualityAsync(["hook", "pre-push", "--repo", c.wt, "--no-deps"], {}, `${branch(c)}\n`);
      await until(() => existsSync(join(c.wt, "sleep.pid")) && read(c.wt, "sleep.pid").trim() !== "");
      const pid = Number(read(c.wt, "sleep.pid"));
      run.child.kill(signal);
      const r = await run.done;
      expect([r.status, alive(pid)]).toEqual([code, false]);
    }, 60_000);
  }

  test("a detached HEAD at the pushed commit runs the tests; detached elsewhere skips them with a note", () => {
    const at = twoCheckouts(NEG_TEST);
    git(at.wt, "checkout", "-q", "--detach", at.b);
    const ok = push(at.wt, [`HEAD ${at.b} refs/heads/B ${at.base}`]);
    expect([ok.status, ok.started]).toEqual([0, true]);
    const off = twoCheckouts(NEG_TEST);
    git(off.wt, "checkout", "-q", "--detach", off.base);
    const skipped = push(off.wt, [`HEAD ${off.b} refs/heads/B ${off.base}`]);
    expect([skipped.status, skipped.out.includes("pre-push: touched tests not run: pushing"), skipped.out.includes("(HEAD), this checkout is at"), skipped.started]).toEqual([0, true, true, false]);
  }, 60_000);

  test("a deletion push checks nothing and runs nothing", () => {
    const { main } = twoCheckouts(NEG_TEST);
    const r = push(main, [`(delete) ${ZERO} refs/heads/B ${git(main, "rev-parse", "HEAD")}`]);
    expect([r.status, r.started, r.out.includes("this checkout is at")]).toEqual([0, false, false]);
  }, 60_000);
});
