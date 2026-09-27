// pre-push judges the pushed commit: the touched tests run on the checked-out tree, so that tree must
// be the pushed commit, clean in the files the tests read. Spawned: bun scripts/quality.ts hook pre-push.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ADD, ADD_NEG, ADD_TEST, cleanup, commit, git, laneEnv, NEG_TEST, nodeRepo, nodeTest, read, SCRIPT, tmp, write } from "./testkit.ts";

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
const wrongTree = (sha: string, head: string) => `pre-push: pushing ${sha} (refs/heads/B), this checkout is at ${head}; touched tests run on the checked-out tree, push from a checkout of that commit`;

describe("pre-push judges the pushed commit", () => {
  test("a branch pushed from a checkout at another commit is blocked; its tests do not start", () => {
    const c = twoCheckouts(NEG_TEST);
    const r = push(c.main, [branch(c)]);
    expect([r.status === 0, r.out.includes(wrongTree(git(c.main, "rev-parse", "--short", c.b), git(c.main, "rev-parse", "--short", "HEAD"))), r.started]).toEqual([false, true, false]);
  }, 60_000);

  test("a red branch pushed from a green checkout is blocked, not passed", () => {
    const c = twoCheckouts(RED_NEG);
    const r = push(c.main, [branch(c)]);
    expect([r.status === 0, r.out.includes("this checkout is at"), r.started]).toEqual([false, true, false]);
  }, 60_000);

  test("the same push from the branch's own worktree runs the tests as before", () => {
    const green = twoCheckouts(NEG_TEST);
    const ok = push(green.wt, [branch(green)]);
    expect([ok.status, ok.started, ok.out.includes("pre-push: 1 touched test file(s) pass")]).toEqual([0, true, true]);
    const red = twoCheckouts(RED_NEG);
    const failed = push(red.wt, [branch(red)]);
    expect([failed.status, failed.started, failed.out.includes("pre-push: 1 touched test file(s) exit 1")]).toEqual([1, true, true]);
  }, 60_000);

  test("uncommitted edits in a selected test or a deleted pushed file block with the path; tests do not run", () => {
    const edited = twoCheckouts(NEG_TEST);
    write(edited.wt, "src/calc.test.ts", nodeTest(ADD_TEST));
    const r1 = push(edited.wt, [branch(edited)]);
    expect([r1.status === 0, r1.out.includes("pre-push: uncommitted changes in files the touched tests read: src/calc.test.ts; commit or stash them"), r1.started]).toEqual([false, true, false]);
    const deleted = twoCheckouts(NEG_TEST);
    rmSync(join(deleted.wt, "src/calc.ts"));
    const r2 = push(deleted.wt, [branch(deleted)]);
    expect([r2.status === 0, r2.out.includes("files the touched tests read: src/calc.ts;"), r2.started]).toEqual([false, true, false]);
  }, 60_000);

  test("an unrelated dirty file does not block", () => {
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

  test("a deletion push checks nothing and runs nothing", () => {
    const { main } = twoCheckouts(NEG_TEST);
    const r = push(main, [`(delete) ${ZERO} refs/heads/B ${git(main, "rev-parse", "HEAD")}`]);
    expect([r.status, r.started, r.out.includes("this checkout is at")]).toEqual([0, false, false]);
  }, 60_000);
});
