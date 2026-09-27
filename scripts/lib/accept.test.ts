// check --since <rev> --tests, the load wait at every test-run site, and the runner summaries.
// Spawned against fixture repos: bun scripts/quality.ts ...
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { buildOpts, DEFAULTS, loadToml, readArgs } from "./config.ts";
import { parseTestSummary } from "./crap.ts";
import { mutantTestCommand, type Runner, touchedCoverageCommand } from "./lang.ts";
import { waitForLoad } from "./load.ts";
import { ADD, ADD_NEG, ADD_TEST, alive, cleanup, commit, git, laneEnv, NEG_TEST, nodeRepo, nodeTest, quality, qualityAsync, read, SCRIPT, SLEEPER, tmp, until, write } from "./testkit.ts";

afterAll(cleanup);

const OUT = ".scratch/quality";
const checkTests = (repo: string, ...extra: string[]) => quality(["check", "--repo", repo, "--since", "HEAD~1", "--tests", "--no-deps", ...extra]);
const runDirs = (repo: string) => (existsSync(join(repo, OUT, "touched")) ? readdirSync(join(repo, OUT, "touched")) : []);
const lcovOf = (file: string, lines: number[]) => `TN:\\nSF:${file}\\n${lines.map((n) => `DA:${n},1`).join("\\n")}\\nend_of_record\\n`;

// One changed function (add gains a branch) and its sibling test.
function changedRepo(cases = [ADD_TEST, NEG_TEST], tests = "") {
  const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST) }, tests);
  write(repo, "src/calc.ts", ADD_NEG);
  write(repo, "src/calc.test.ts", nodeTest(...cases));
  commit(repo);
  return repo;
}

describe("check --since <rev> --tests", () => {
  test("node: the touched test passes, CRAP of the changed function comes from its coverage, exit 0", () => {
    const repo = changedRepo();
    const r = checkTests(repo);
    expect(r.stdout).toMatch(/^tests: 1 touched test file\(s\) pass in [\d.]+s, coverage fresh \(touched\)$/m);
    expect(r.stdout).toContain("touched tests: 1 by name, 0 by direct import, 0 by second-hop import");
    expect(read(repo, `${OUT}/check.md`)).toContain("- 2.0 cc 2 cov 100% src/calc.ts:1-4 Function 'add'");
    expect([r.status, runDirs(repo), existsSync(join(repo, OUT, "lcov.info"))]).toEqual([0, [], false]);
  }, 60_000);

  test("bun (no package.json): the file-aware bun coverage command judges the change", () => {
    const bunTest = (...cases: string[]) => `import { test, expect } from "bun:test";\nimport { add } from "./calc.ts";\n${cases.join("\n")}\n`;
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": bunTest('test("add", () => expect(add(1, 2)).toBe(3));') }, "", false);
    write(repo, "src/calc.ts", ADD_NEG);
    write(repo, "src/calc.test.ts", bunTest('test("add", () => expect(add(1, 2)).toBe(3));', 'test("neg", () => expect(add(-1, 2)).toBe(2));'));
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, /pass in [\d.]+s, coverage fresh \(touched\)/.test(r.stdout), r.stdout.includes("bun test")]).toEqual([0, true, true]);
    expect(read(repo, `${OUT}/check.md`)).toMatch(/cov 100% src\/calc\.ts:1-4/);
  }, 60_000);

  test("a failing touched test is tests/red with the log path; exit 1; the run directory is kept", () => {
    const repo = changedRepo([ADD_TEST, 'test("neg", () => assert.equal(add(-1, 2), 99));']);
    const r = checkTests(repo);
    const log = /tests\/red .*; log (\S+tests\.log)/.exec(r.stdout)?.[1] ?? "";
    expect([r.status, existsSync(log), r.stdout.includes("tests: run files kept at")]).toEqual([1, true, true]);
  }, 60_000);

  test("a changed source no test touches is tamper/no-tests-ran; qg:no-test in <rev>..HEAD bypasses with no run", () => {
    const red = nodeRepo({ "src/calc.ts": ADD });
    write(red, "src/calc.ts", ADD_NEG);
    commit(red, "branch");
    expect([checkTests(red).status, checkTests(red).stdout.includes("tamper/no-tests-ran")]).toEqual([1, true]);
    const bypass = nodeRepo({ "src/calc.ts": ADD });
    write(bypass, "src/calc.ts", ADD_NEG);
    commit(bypass, "branch\n\nqg:no-test generated wrapper");
    const r = checkTests(bypass);
    expect([r.status, r.stdout.includes("note: bypass tamper/no-tests-ran commit-msg generated wrapper"), r.stdout.includes("cov/diff: not run"), r.stdout.includes("tests: not run, no touched tests"), runDirs(bypass)]).toEqual([0, true, true, true, []]);
  }, 60_000);

  test("added lines the touched tests never execute block as cov/diff naming the file", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST) });
    write(repo, "src/calc.ts", `${ADD}export function sub(a: number, b: number) {\n  const d = a - b;\n  return d;\n}\n`);
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, /^cov\/diff\s+src\/calc\.ts:\d+\s+cov\/diff: [\d.]+% .*minimum 80%/m.test(r.stdout)]).toEqual([1, true]);
  }, 60_000);

  test("a changed source whose test imports another module: cov/diff names the file", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/other.ts": "export const one = () => 1;\n", "src/calc.test.ts": 'import { test } from "node:test";\nimport { one } from "./other.ts";\ntest("one", () => { one(); });\n' });
    write(repo, "src/calc.ts", ADD_NEG);
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, r.stdout.includes("cov/diff  src/calc.ts:0  1 changed source file(s) without lcov data")]).toEqual([1, true]);
  }, 60_000);

  test("a timeout is tests/timeout; the whole process group is killed", async () => {
    const repo = changedRepo([ADD_TEST], `touched_timeout_s = 1\ntouched_cmd = 'sleep 30 & echo $! > sleep.pid; wait; : {files}'`);
    const r = checkTests(repo);
    const pid = Number(read(repo, "sleep.pid"));
    await until(() => !alive(pid), 5_000);
    expect([r.status, r.stdout.includes("tests/timeout after 1s")]).toEqual([1, true]);
  }, 60_000);

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${signal} during the touched run kills its process group, prints the kept run directory, exit ${code}`, async () => {
      const repo = changedRepo([ADD_TEST], `touched_cmd = '${SLEEPER}'`);
      const run = qualityAsync(["check", "--repo", repo, "--since", "HEAD~1", "--tests", "--no-deps"]);
      await until(() => existsSync(join(repo, "sleep.pid")) && read(repo, "sleep.pid").trim() !== "");
      const pid = Number(read(repo, "sleep.pid"));
      run.child.kill(signal);
      const r = await run.done;
      const kept = /tests: run files kept at (\S+)/.exec(r.stdout)?.[1] ?? "";
      expect([r.status, alive(pid), kept.includes("/touched/run-"), existsSync(kept)]).toEqual([code, false, true, true]);
    }, 60_000);
  }

  const invalid: [string, string][] = [
    ["nothing written", "true"],
    ["garbage", `printf 'garbage\\n' > "$QG_LCOV"`],
    ["truncated", `printf 'TN:\\nSF:src/calc.ts\\nDA:1' > "$QG_LCOV"`],
    ["no DA lines", `printf 'TN:\\nSF:src/calc.ts\\nend_of_record\\n' > "$QG_LCOV"`],
  ];
  for (const [name, cmd] of invalid) {
    test(`exit 0 with invalid coverage (${name}) is tests: ERROR invalid coverage, exit 1`, () => {
      const repo = changedRepo([ADD_TEST], `touched_cmd = '''${cmd}; : {files}'''`);
      const r = checkTests(repo);
      expect([r.status, /^tests: ERROR invalid coverage at \S+lcov\.info, see \S+tests\.log$/m.test(r.stdout)]).toEqual([1, true]);
    }, 60_000);
  }

  test("valid lcov that lacks the changed source is the blocking cov/diff finding", () => {
    const repo = changedRepo([ADD_TEST], `touched_cmd = '''printf '${lcovOf("src/other.ts", [1])}' > "$QG_LCOV"; : {files}'''`);
    const r = checkTests(repo);
    expect([r.status, r.stdout.includes("cov/diff  src/calc.ts:0")]).toEqual([1, true]);
  }, 60_000);

  test("command precedence: touched_cmd, then project.test_cmd with {files}, else the adapter's, with a note", () => {
    const lcov = lcovOf("src/calc.ts", [1, 2, 3, 4]);
    const withFiles = changedRepo([ADD_TEST, NEG_TEST]);
    write(withFiles, ".quality.toml", read(withFiles, ".quality.toml").replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = '''printf '${lcov}' > "$QG_LCOV"; echo PROJECT {files}'''`));
    const own = checkTests(withFiles);
    expect([own.status, own.stdout.includes("note: tests/touched command: printf")]).toEqual([0, true]);
    const without = changedRepo([ADD_TEST, NEG_TEST]);
    write(without, ".quality.toml", read(without, ".quality.toml").replace('base = "HEAD"', 'base = "HEAD"\ntest_cmd = "true"'));
    const adapter = checkTests(without);
    expect([adapter.status, adapter.stdout.includes("note: tests/touched: project.test_cmd has no {files}"), adapter.stdout.includes("note: tests/touched command: node --test")]).toEqual([0, true, true]);
    const bad = changedRepo([ADD_TEST], "touched_cmd = 'node --test'");
    expect([checkTests(bad).status, checkTests(bad).stderr.includes("[tests] touched_cmd must be a command with {files}")]).toEqual([2, true]);
  }, 90_000);

  test("docs-only: scope docs-only, no test runs, no lcov written", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST), "README.md": "before\n" }, "touched_cmd = 'touch ran; : {files}'");
    write(repo, "README.md", "after\n");
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, r.stdout.includes("scope: docs-only"), existsSync(join(repo, "ran")), existsSync(join(repo, OUT, "touched"))]).toEqual([0, true, false, false]);
  }, 60_000);

  test("flags: --tests needs exactly one --since and no --staged/--all; --test belongs to mutant", () => {
    const repo = changedRepo();
    const refused = [
      ["check", "--repo", repo, "--tests"],
      ["check", "--repo", repo, "--tests", "--since", "HEAD~1", "--staged"],
      ["check", "--repo", repo, "--tests", "--since", "HEAD~1", "--all"],
      ["check", "--repo", repo, "--tests", "--since", "HEAD~1", "--since=HEAD"],
      ["check", "--repo", repo, "--since", "HEAD~1", "--test", "src/calc.test.ts"],
      ["mutant", "--repo", repo, "--file", "src/calc.ts", "--find", "a + b", "--replace", "a - b", "--tests"],
    ].map((args) => quality(args).status);
    expect(refused).toEqual([2, 2, 2, 2, 2, 2]);
  }, 60_000);

  test("a log that cannot be created is a CLI error, exit 2", () => {
    const repo = changedRepo();
    write(repo, `${OUT}/touched`, "a file where the run directories go\n");
    const r = checkTests(repo);
    expect([r.status, r.stderr.startsWith("code-quality: ")]).toEqual([2, true]);
  }, 60_000);

  test("second-hop selection: test -> *.render-harness.tsx -> component", () => {
    const repo = nodeRepo({
      "src/button.tsx": "export const label = (x: string) => x;\n",
      "src/button.render-harness.tsx": 'import { label } from "./button.tsx";\nexport const render = () => label("a");\n',
      "src/view.test.ts": 'import { render } from "./button.render-harness.tsx";\nrender();\n',
    }, `touched_cmd = '''printf '${lcovOf("src/button.tsx", [1])}' > "$QG_LCOV"; : {files}'''`);
    write(repo, "src/button.tsx", "export const label = (x: string) => `${x}!`;\n");
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, r.stdout.includes("touched tests: 0 by name, 0 by direct import, 1 by second-hop import")]).toEqual([0, true]);
  }, 60_000);

  test("two concurrent scopes each read only their own run directory", async () => {
    const failing = (name: string) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${name} } from "./${name}.ts";\ntest("${name}", () => assert.equal(${name}(), 0));\n`;
    const cmd = 'sleep 1; node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination="$QG_LCOV" --test-reporter=spec --test-reporter-destination=stdout {files}';
    const repo = nodeRepo({ "src/a.ts": "export const a = () => 1;\n", "src/b.ts": "export const b = () => 1;\n", "src/a.test.ts": failing("a"), "src/b.test.ts": failing("b") }, `touched_cmd = '${cmd}'`);
    write(repo, "src/a.ts", "export const a = () => 2;\n");
    commit(repo, "a");
    write(repo, "src/b.ts", "export const b = () => 2;\n");
    commit(repo, "b");
    const onlyB = qualityAsync(["check", "--repo", repo, "--since", "HEAD~1", "--tests", "--no-deps"]);
    const both = qualityAsync(["check", "--repo", repo, "--since", "HEAD~2", "--tests", "--no-deps"]);
    const [rb, rab] = await Promise.all([onlyB.done, both.done]);
    const kept = (r: { stdout: string }) => /tests: run files kept at (\S+)/.exec(r.stdout)?.[1] ?? "";
    const [dirB, dirAB] = [kept(rb), kept(rab)];
    const covers = (dir: string, file: string) => new RegExp(`^SF:(?:.*/)?src/${file}$`, "m").test(readFileSync(join(dir, "lcov.info"), "utf8"));
    expect([rb.status, rab.status, dirB !== dirAB, dirB.includes("/touched/run-"), dirAB.includes("/touched/run-")]).toEqual([1, 1, true, true, true]);
    expect([covers(dirB, "a.ts"), covers(dirB, "b.ts"), covers(dirAB, "a.ts"), covers(dirAB, "b.ts")]).toEqual([false, true, true, true]);
    expect([rb.stdout.includes(`log ${dirB}/tests.log`), rab.stdout.includes(`log ${dirAB}/tests.log`)]).toEqual([true, true]);
  }, 90_000);
});

describe("full consumers never look at touched/", () => {
  test("--skip-tests with only a touched lcov refuses as for no lcov; --update-baseline runs full coverage; touched files stay", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "coverage.lcov": lcovOf("src/calc.ts", [1, 2, 3]).replaceAll("\\n", "\n") });
    write(repo, ".quality.toml", read(repo, ".quality.toml").replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = 'cp coverage.lcov "$QG_LCOV"'`));
    const touched = `${OUT}/touched/run-1-abcd/lcov.info`;
    write(repo, touched, read(repo, "coverage.lcov"));
    write(repo, `${OUT}/touched/run-1-abcd/lcov.meta.json`, '{"commit":"x","fingerprint":"y","code":0,"failed":0}\n');
    const skip = quality(["--repo", repo, "--no-deps", "--skip-tests"]);
    expect([skip.status, skip.stderr.includes(`--skip-tests refused: no ${join(repo, OUT, "lcov.info")} with lcov.meta.json next to it`)]).toEqual([2, true]);
    const before = read(repo, touched);
    const baseline = quality(["--repo", repo, "--no-deps", "--update-baseline", "--baseline", join(repo, "baseline.json")]);
    expect([baseline.status, baseline.stdout.includes("baseline written"), existsSync(join(repo, OUT, "lcov.meta.json")), read(repo, touched)]).toEqual([0, true, true, before]);
  }, 60_000);

  test("a plain check after check --tests reads no touched lcov", () => {
    const repo = changedRepo();
    expect(checkTests(repo).status).toBe(0);
    const plain = quality(["check", "--repo", repo, "--since", "HEAD~1", "--no-deps"]);
    expect(plain.stdout).toContain("tests: not run, no fresh lcov");
  }, 60_000);
});

describe("load wait before every test run", () => {
  const LOAD = { QG_TEST_LOADAVG: "5" };
  const waited = (r: { stdout: string }) => [r.stdout.includes("tests: waited 2s for load 5.0 (max 1)"), r.stdout.includes("note: tests/load ran at load 5.0 after 2s")];
  const startedAfter = (repo: string, t0: number) => Number(read(repo, "started").split("\n")[0]) >= Math.floor(t0 / 1000) + 2;
  const WAIT = "max_load = 1\nload_wait_s = 2";

  test("full gate", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD }, WAIT);
    write(repo, ".quality.toml", read(repo, ".quality.toml").replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = '''date +%s > started; printf '${lcovOf("src/calc.ts", [1, 2, 3])}' > "$QG_LCOV"'''`));
    const t0 = Date.now();
    const r = quality(["--repo", repo, "--no-deps"], LOAD);
    expect([...waited(r), startedAfter(repo, t0)]).toEqual([true, true, true]);
  }, 60_000);

  test("check --tests", () => {
    const repo = changedRepo([ADD_TEST, NEG_TEST], `${WAIT}\ntouched_cmd = '''date +%s > started; printf '${lcovOf("src/calc.ts", [1, 2, 3, 4])}' > "$QG_LCOV"; : {files}'''`);
    const t0 = Date.now();
    const r = quality(["check", "--repo", repo, "--since", "HEAD~1", "--tests", "--no-deps"], LOAD);
    expect([...waited(r), startedAfter(repo, t0), r.status]).toEqual([true, true, true, 0]);
  }, 60_000);

  test("pre-push", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST) }, WAIT);
    write(repo, ".quality.toml", `${read(repo, ".quality.toml")}\n[hooks]\npre_push_test_cmd = 'date +%s > started; node --test {files}'\n`);
    commit(repo, "config");
    const before = git(repo, "rev-parse", "HEAD");
    write(repo, "src/calc.ts", ADD_NEG);
    write(repo, "src/calc.test.ts", nodeTest(ADD_TEST, NEG_TEST));
    commit(repo);
    const head = git(repo, "rev-parse", "HEAD");
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [SCRIPT, "hook", "pre-push", "--repo", repo, "--no-deps"], { input: `refs/heads/main ${head} refs/heads/main ${before}\n`, encoding: "utf8", env: laneEnv(LOAD) });
    expect([...waited(r), startedAfter(repo, t0)]).toEqual([true, true, true]);
  }, 60_000);

  test("mutant", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST) }, `${WAIT}\nmutant_cmd = 'date +%s >> started; node --test {files}'`);
    const t0 = Date.now();
    const r = quality(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find", "a + b", "--replace", "a - b"], LOAD);
    expect([...waited(r), startedAfter(repo, t0), r.status]).toEqual([true, true, true, 0]);
  }, 60_000);

  const opts = (tests: Partial<typeof DEFAULTS.tests>) => ({ toml: { ...DEFAULTS, tests: { ...DEFAULTS.tests, ...tests } } }) as never;
  const probe = (loads: number[]) => {
    const log: string[] = [];
    const sleeps: number[] = [];
    let i = 0;
    return { log, sleeps, deps: { load: () => loads[Math.min(i++, loads.length - 1)], sleep: (s: number) => sleeps.push(s), log: (line: string) => log.push(line) } };
  };

  test("a load that stays high polls every min(10, remaining) s up to the limit, then runs with a note", () => {
    const p = probe([9]);
    waitForLoad(opts({ max_load: 2, load_wait_s: 25 }), p.deps);
    expect([p.sleeps, p.log]).toEqual([[10, 10, 5], ["tests: waited 25s for load 9.0 (max 2)", "note: tests/load ran at load 9.0 after 25s"]]);
  });

  test("a load that drops ends the wait; no line when no sleep happened; 0 turns it off; loadavg 0 means no wait", () => {
    const drops = probe([9, 1]);
    waitForLoad(opts({ max_load: 2, load_wait_s: 600 }), drops.deps);
    expect([drops.sleeps, drops.log]).toEqual([[10], ["tests: waited 10s for load 1.0 (max 2)"]]);
    for (const [tests, loads] of [[{ max_load: 2 }, [1]], [{ max_load: 0 }, [99]], [{ max_load: 2 }, [0]]] as const) {
      const p = probe([...loads]);
      waitForLoad(opts(tests), p.deps);
      expect([p.sleeps, p.log]).toEqual([[], []]);
    }
    const zero = probe([9]);
    waitForLoad(opts({ max_load: 2, load_wait_s: 0 }), zero.deps);
    expect([zero.sleeps, zero.log]).toEqual([[], ["note: tests/load ran at load 9.0 after 0s"]]);
  });

  test("the default max_load is twice the CPU count", () => {
    expect(DEFAULTS.tests.max_load).toBe(2 * availableParallelism());
  });

  test("invalid [tests] values are config errors", () => {
    const dir = tmp();
    const bad = ["max_load = -1", 'max_load = "x"', "load_wait_s = 1.5", "load_wait_s = -2", "touched_timeout_s = 0", "mutant_cmd = 'node --test'"];
    for (const line of bad) {
      writeFileSync(join(dir, "q.toml"), `[tests]\n${line}\n`);
      expect(() => loadToml(join(dir, "q.toml"))).toThrow("[tests]");
    }
  });
});

describe("runner summaries", () => {
  const FIXTURES = join(import.meta.dir, "../fixtures/summaries");
  const expected: [string, Runner, { ran: number; failed: number }][] = [
    ["node-pass", "node", { ran: 2, failed: 0 }], ["node-fail", "node", { ran: 2, failed: 1 }], ["node-empty", "node", { ran: 1, failed: 0 }],
    ["bun-pass", "bun", { ran: 2, failed: 0 }], ["bun-fail", "bun", { ran: 2, failed: 1 }], ["bun-empty", "bun", { ran: 0, failed: 0 }],
    ["vitest-pass", "vitest", { ran: 2, failed: 0 }], ["vitest-fail", "vitest", { ran: 2, failed: 1 }], ["vitest-empty", "vitest", { ran: 0, failed: 0 }],
    ["pytest-pass", "py", { ran: 2, failed: 0 }], ["pytest-fail", "py", { ran: 2, failed: 1 }], ["pytest-empty", "py", { ran: 0, failed: 0 }],
  ];
  for (const [name, runner, counts] of expected) {
    test(`${name}: real ${runner} output`, () => {
      expect(parseTestSummary(runner, readFileSync(join(FIXTURES, `${name}.log`), "utf8"))).toEqual(counts);
    });
  }

  test("the runner output fixtures are tracked by git (a clean checkout has them)", () => {
    const tracked = spawnSync("git", ["ls-files", "--", "scripts/fixtures/summaries"], { cwd: join(import.meta.dir, "../.."), encoding: "utf8" }).stdout.trim().split("\n");
    expect(tracked).toEqual(expected.map(([name]) => `scripts/fixtures/summaries/${name}.log`).sort());
  });

  test("a log without the runner's summary is an error, not zero", () => {
    expect(parseTestSummary("node", "hello\n")).toEqual({ error: "no node test summary in the log" });
    expect(parseTestSummary("py", readFileSync(join(FIXTURES, "node-pass.log"), "utf8"))).toEqual({ error: "no pytest test summary in the log" });
  });

  test("a language without a file-aware command: touched runs its full coverage with a note; mutant has none", () => {
    const input = { repo: tmp(), lang: "go", readPackage: () => "", tests: { touched_cmd: "", mutant_cmd: "" }, testCmd: "" };
    expect(touchedCoverageCommand(input).notes).toEqual(["note: tests/touched not supported for go"]);
    expect([touchedCoverageCommand(input).cmd.startsWith("go test"), mutantTestCommand(input)]).toEqual([true, ""]);
  });
});

describe("guarded config", () => {
  test("a [tests] key changed together with code is tamper/baseline-touched", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD, "src/calc.test.ts": nodeTest(ADD_TEST) });
    write(repo, ".quality.toml", `${read(repo, ".quality.toml")}\n[tests]\nmax_load = 0\n`);
    write(repo, "src/calc.ts", ADD_NEG);
    git(repo, "add", "-A");
    const r = quality(["check", "--repo", repo, "--staged", "--no-deps"]);
    expect([r.status, r.stdout.includes("protected config changed: tests.max_load")]).toEqual([1, true]);
    expect(buildOpts(readArgs(["check", "--repo", repo])).toml.tests.max_load).toBe(0);
  }, 60_000);
});
