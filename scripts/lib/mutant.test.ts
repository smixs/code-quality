// mutant: spawned against fixture repos (bun scripts/quality.ts mutant ...); the restore-write failure
// runs the exported orchestrator with an injected file write.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildOpts, readArgs } from "./config.ts";
import { runMutant } from "./mutant.ts";
import { ADD_NEG, ADD_TEST, cleanup, git, NEG_TEST, nodeRepo, nodeTest, quality, qualityAsync, read, tmp, until, write } from "./testkit.ts";

afterAll(cleanup);
process.env.QG_TEST_LOADAVG = "0";

const OUT = ".scratch/quality";
const LOCK = `${OUT}/mutant/lock`;
const mutant = (repo: string, find: string, replace: string, ...extra: string[]) => quality(["mutant", "--repo", repo, "--file", "src/calc.ts", `--find=${find}`, `--replace=${replace}`, ...extra]);
const sha = (repo: string, file = "src/calc.ts") => createHash("sha256").update(readFileSync(join(repo, file))).digest("hex");
const status = (repo: string) => git(repo, "status", "--porcelain", "--", "src/calc.ts");
const noState = (repo: string) => !existsSync(join(repo, OUT, "mutant"));
const rows = (repo: string) => read(repo, `${OUT}/mutants.log`).trim().split("\n").map((line) => JSON.parse(line));
const calcRepo = (tests = "") => nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": nodeTest(ADD_TEST, NEG_TEST) }, tests);
const KILLS = ["a + b", "a - b"] as const;
const SURVIVES = ["return b;", "return b + 0;"] as const;
// The preflight passes; the mutated run (the second) runs `second` first.
const secondRun = (second: string) => `mutant_cmd = 'if [ -f ${OUT}/pre.done ]; then ${second}; fi; touch ${OUT}/pre.done; node --test {files}'`;

describe("mutant outcomes", () => {
  test("KILLED: exit 0, the file and git status as before, a JSONL record, no state left", () => {
    const repo = calcRepo();
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.trim(), sha(repo), status(repo), noState(repo)]).toEqual([0, "MUTANT KILLED: 1 failing test(s) in src/calc.test.ts", before, "", true]);
    const [row] = rows(repo);
    expect({ ...row, time: typeof row.time, pid: typeof row.pid }).toEqual({ time: "string", file: "src/calc.ts", find: "a + b", replace: "a - b", tests: ["src/calc.test.ts"], outcome: "killed", failing: 1, pid: "number" });
  }, 60_000);

  test("SURVIVED: exit 1, restored", () => {
    const repo = calcRepo();
    const before = sha(repo);
    const r = mutant(repo, ...SURVIVES);
    expect([r.status, r.stdout.trim(), sha(repo), noState(repo), rows(repo)[0].outcome]).toEqual([1, "MUTANT SURVIVED: src/calc.test.ts passed with the mutant", before, true, "survived"]);
  }, 60_000);

  test("find text 0 or more than 1 times: MUTANT ERROR with the count, file untouched, nothing locked", () => {
    const repo = calcRepo();
    const before = sha(repo);
    const none = mutant(repo, "zzz", "y");
    const many = mutant(repo, "return", "yield");
    expect([none.status, none.stdout.includes("find text occurs 0 times"), many.status, many.stdout.includes("find text occurs 2 times"), sha(repo), noState(repo)]).toEqual([2, true, 2, true, before, true]);
  }, 60_000);

  test("tests that run nothing (an empty bun test file): MUTANT ERROR no test ran, nothing written", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": "// no tests yet\n" }, "", false);
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("MUTANT ERROR: original tests: no test ran"), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);

  test("original tests red: MUTANT ERROR, nothing written", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": nodeTest('test("red", () => assert.equal(add(1, 1), 3));') });
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("MUTANT ERROR: original tests: fail on the original bytes"), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);

  test("exit != 0 with 0 failed tests is MUTANT ERROR, not KILLED", () => {
    const repo = calcRepo(`mutant_cmd = 'node --test {files}; code=$?; if [ -f ${OUT}/pre.done ]; then exit 3; fi; touch ${OUT}/pre.done; exit $code'`);
    const before = sha(repo);
    const r = mutant(repo, ...SURVIVES);
    expect([r.status, r.stdout.includes("MUTANT ERROR: tests exited 3 without a failing test"), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);

  test("a summary that cannot be read is MUTANT ERROR", () => {
    const repo = calcRepo("mutant_cmd = 'echo done; : {files}'");
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("MUTANT ERROR: original tests: cannot be read: no node, bun, vitest or pytest test summary in the log")]).toEqual([2, true]);
  }, 60_000);

  test("a preflight over mutant_timeout_s is MUTANT ERROR, nothing written", () => {
    const repo = calcRepo("mutant_timeout_s = 2\nmutant_cmd = 'sleep 30; : {files}'");
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("MUTANT ERROR: original tests: timed out after 2s"), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);

  test("a mutated run over mutant_timeout_s is MUTANT ERROR, restored", () => {
    const repo = calcRepo(`mutant_timeout_s = 2\n${secondRun("sleep 30")}`);
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("MUTANT ERROR: the mutated run timed out after 2s"), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);

  test("the load wait runs once, before the preflight; none between the mutant write and its run", () => {
    const repo = calcRepo("max_load = 1\nload_wait_s = 2\nmutant_cmd = 'date +%s >> started; node --test {files}'");
    const t0 = Date.now();
    const r = quality(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find=a + b", "--replace=a - b"], { QG_TEST_LOADAVG: "5" });
    const [pre, mutated] = read(repo, "started").trim().split("\n").map(Number);
    const waits = r.stdout.split("\n").filter((line) => line.startsWith("tests: waited")).length;
    expect([r.status, waits, pre >= Math.floor(t0 / 1000) + 2, mutated - pre < 2]).toEqual([0, 1, true, true]);
  }, 60_000);

  test("a custom mutant_cmd may print another known runner's summary (bun in a node repo)", () => {
    const bunTest = 'import { test, expect } from "bun:test";\nimport { add } from "./calc.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n';
    const repo = nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": bunTest }, "mutant_cmd = 'bun test {files}'");
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.trim()]).toEqual([0, "MUTANT KILLED: 1 failing test(s) in src/calc.test.ts"]);
  }, 60_000);

  test("package.json without vitest and a bun.lockb: the mutant runs its tests through bun, KILLED", () => {
    const bunTest = 'import { test, expect } from "bun:test";\nimport { add } from "./calc.ts";\ntest("add", () => expect(add(1, 2)).toBe(3));\n';
    const repo = nodeRepo({ "bun.lockb": "", "src/calc.ts": ADD_NEG, "src/calc.test.ts": bunTest });
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.trim(), sha(repo), noState(repo)]).toEqual([0, "MUTANT KILLED: 1 failing test(s) in src/calc.test.ts", before, true]);
  }, 60_000);

  test("bun output in two buckets: the failures of both are summed, KILLED", () => {
    const buckets = 'printf " 2 pass\\nRan 4 tests across 2 files.\\n 2 fail\\n 0 fail\\n"; exit 1';
    const green = 'printf " 2 pass\\n 0 fail\\nRan 2 tests across 1 file.\\n"; : {files}';
    const repo = calcRepo(`mutant_cmd = 'if [ -f ${OUT}/pre.done ]; then ${buckets}; fi; touch ${OUT}/pre.done; ${green}'`);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.trim()]).toEqual([0, "MUTANT KILLED: 2 failing test(s) in src/calc.test.ts"]);
  }, 60_000);

  test("a language without a file-aware test command is MUTANT ERROR unless [tests] mutant_cmd", () => {
    const repo = nodeRepo({ "go.mod": "module example.test/m\n", "src/calc.go": "package calc\nfunc Add(a, b int) int { return a + b }\n" }, "", false);
    write(repo, ".quality.toml", read(repo, ".quality.toml").replace('language = "ts"', 'language = "go"'));
    const r = quality(["mutant", "--repo", repo, "--file", "src/calc.go", "--find=a + b", "--replace=a - b"]);
    expect([r.status, r.stdout.trim()]).toEqual([2, "MUTANT ERROR: no file-aware test command for go; set [tests] mutant_cmd"]);
  }, 60_000);
});

describe("mutant arguments and target", () => {
  test("empty find, find = replace, a missing, symlinked, outside, non-UTF-8 or staged target: MUTANT ERROR before any lock", () => {
    const repo = calcRepo();
    symlinkSync(join(repo, "src/calc.ts"), join(repo, "src/link.ts"));
    writeFileSync(join(repo, "src/bin.ts"), Buffer.from([0xff, 0xfe, 0x61]));
    const file = (path: string) => quality(["mutant", "--repo", repo, "--file", path, "--find=a", "--replace=b"]);
    const cases = [
      [mutant(repo, "", "x"), "--find is empty"],
      [mutant(repo, "a + b", "a + b"), "--find and --replace are the same text"],
      [file("src/gone.ts"), "file not found"],
      [file("src/link.ts"), "not a regular file"],
      [file("src/bin.ts"), "not a UTF-8 text file"],
    ] as const;
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, "outside.ts"), "a\n");
    const outside = file(relative(repo, join(elsewhere, "outside.ts")));
    expect(cases.map(([r, why]) => [r.status, r.stdout.includes(why)])).toEqual(cases.map(() => [2, true]));
    expect([outside.status, outside.stdout.includes("file is outside the repo")]).toEqual([2, true]);
    write(repo, "src/calc.ts", `${ADD_NEG}// staged\n`);
    git(repo, "add", "src/calc.ts");
    const staged = mutant(repo, ...KILLS);
    expect([staged.status, staged.stdout.includes("has staged changes"), noState(repo)]).toEqual([2, true, true]);
  }, 60_000);

  test("a NUL byte in an argument: MUTANT ERROR before any lock", async () => {
    const repo = calcRepo();
    const o = buildOpts(readArgs(["mutant", "--repo", repo]));
    const r = await runMutant(o, { file: "src/calc.ts", find: "a + b", replace: "a\0b", tests: [] });
    expect([r.code, r.line, noState(repo)]).toEqual([2, "MUTANT ERROR: an argument contains a NUL byte", true]);
  }, 60_000);

  test("--test replaces the selection; each must be a normalized repo-relative regular test file", () => {
    const repo = nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": nodeTest(ADD_TEST, NEG_TEST), "src/other.test.ts": 'import { test } from "node:test";\ntest("other", () => {});\n' });
    symlinkSync(join(repo, "src/other.test.ts"), join(repo, "src/linked.test.ts"));
    const own = mutant(repo, ...KILLS, "--test", "src/other.test.ts");
    expect([own.status, own.stdout.trim()]).toEqual([1, "MUTANT SURVIVED: src/other.test.ts passed with the mutant"]);
    const refused = ["./src/calc.test.ts", "src/../src/calc.test.ts", "/src/calc.test.ts", "src/calc.ts", "src/linked.test.ts", "src/gone.test.ts", "../x.test.ts"].map((test) => mutant(repo, ...KILLS, "--test", test));
    expect(refused.map((r) => [r.status, r.stdout.startsWith("MUTANT ERROR: ")])).toEqual(refused.map(() => [2, true]));
    expect(noState(repo)).toBe(true);
  }, 60_000);

  test("unstaged edits before the run survive it", () => {
    const repo = calcRepo();
    write(repo, "src/calc.ts", `${ADD_NEG}// work in progress\n`);
    const before = [sha(repo), status(repo)];
    const r = mutant(repo, ...KILLS);
    expect([r.status, sha(repo), status(repo)]).toEqual([0, ...before]);
  }, 60_000);

  test("a target edited after the preflight: MUTANT ERROR, the edit survives, target and state kept", () => {
    const repo = calcRepo(`mutant_cmd = 'if [ ! -f ${OUT}/pre.done ]; then touch ${OUT}/pre.done; printf "// edit\\\\n" >> src/calc.ts; fi; node --test {files}'`);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("src/calc.ts changed during the preflight; target and state kept"), read(repo, "src/calc.ts"), existsSync(join(repo, LOCK, "owner.json"))]).toEqual([2, true, `${ADD_NEG}// edit\n`, true]);
  }, 60_000);

  test("a target that is neither original nor mutant before the restore: MUTANT ERROR, target and state kept", () => {
    const repo = calcRepo(secondRun('printf "// third\\\\n" >> src/calc.ts'));
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes("is neither the original nor the mutant; target and state kept"), read(repo, "src/calc.ts").endsWith("// third\n"), existsSync(join(repo, LOCK))]).toEqual([2, true, true, true]);
  }, 60_000);

  test("a target whose realpath left the repo before the restore: nothing written, .orig, owner and lock kept, exit 2", () => {
    const elsewhere = tmp();
    const repo = calcRepo(secondRun(`mv src ${elsewhere}/src && ln -s ${elsewhere}/src src`));
    const r = mutant(repo, ...KILLS);
    const kept = ["calc.ts.orig", "owner.json"].map((file) => existsSync(join(repo, LOCK, file)));
    expect([r.status, r.stdout.startsWith("MUTANT ERROR: "), readFileSync(join(elsewhere, "src/calc.ts"), "utf8"), ...kept]).toEqual([2, true, ADD_NEG.replace("a + b", "a - b"), true, true]);
  }, 60_000);

  test("mutants.log that cannot be appended: MUTANT ERROR after the restore", () => {
    const repo = calcRepo();
    mkdirSync(join(repo, OUT, "mutants.log"), { recursive: true });
    const before = sha(repo);
    const r = mutant(repo, ...KILLS);
    expect([r.status, r.stdout.includes(`MUTANT ERROR: cannot append ${join(repo, OUT, "mutants.log")}`), sha(repo), noState(repo)]).toEqual([2, true, before, true]);
  }, 60_000);
});

describe("mutant restore and state", () => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${signal} mid-run: restored, logged, exit ${code}, no state`, async () => {
      const repo = calcRepo(secondRun("sleep 30"));
      const before = sha(repo);
      const run = qualityAsync(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find=a + b", "--replace=a - b"]);
      await until(() => existsSync(join(repo, "src/calc.ts")) && sha(repo) !== before);
      run.child.kill(signal);
      const r = await run.done;
      expect([r.status, r.stdout.trim(), sha(repo), noState(repo), rows(repo)[0].outcome]).toEqual([code, `MUTANT ERROR: interrupted by ${signal}, src/calc.ts restored`, before, true, "interrupted"]);
    }, 60_000);
  }

  test("killed with SIGKILL: the next mutant restores the leftover first", async () => {
    const repo = calcRepo(secondRun("sleep 5"));
    const before = sha(repo);
    const run = qualityAsync(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find=a + b", "--replace=a - b"]);
    await until(() => sha(repo) !== before);
    run.child.kill("SIGKILL");
    await run.done;
    expect(existsSync(join(repo, LOCK, "owner.json"))).toBe(true);
    const r = mutant(repo, ...SURVIVES);
    expect([r.status, r.stdout.split("\n")[0], sha(repo), noState(repo)]).toEqual([1, "restored leftover mutant of src/calc.ts", before, true]);
  }, 60_000);

  const deadPid = () => spawnSync("true").pid!;
  const leftover = (repo: string, owner: Record<string, unknown>) => {
    write(repo, `${LOCK}/calc.ts.orig`, ADD_NEG);
    write(repo, `${LOCK}/owner.json`, JSON.stringify({ pid: deadPid(), started_at: new Date().toISOString(), repo, file: "src/calc.ts", original_sha256: sha(repo), mutant_sha256: "a".repeat(64), ...owner }));
  };

  for (const [name, bad] of [["file {}", { file: {} }], ["pid -1", { pid: -1 }], ["a short sha", { original_sha256: "abc" }]] as const) {
    test(`owner.json with ${name}: malformed mutant state, nothing written, state kept, exit 2`, () => {
      const repo = calcRepo();
      write(repo, "src/calc.ts", ADD_NEG.replace("a + b", "a - b"));
      const mutated = sha(repo);
      leftover(repo, { mutant_sha256: mutated, ...bad });
      const r = mutant(repo, ...SURVIVES);
      const owner = join(repo, LOCK, "owner.json");
      expect([r.status, r.stdout.trim(), sha(repo), existsSync(owner), existsSync(join(repo, LOCK, "calc.ts.orig"))]).toEqual([2, `MUTANT ERROR: malformed mutant state ${owner}; original at ${join(repo, LOCK, "calc.ts.orig")}`, mutated, true, true]);
    }, 60_000);
  }

  test("leftover state: original bytes = stale state removed; a third state or unreadable owner = kept, exit 2", () => {
    const stale = calcRepo();
    leftover(stale, {});
    const r = mutant(stale, ...SURVIVES);
    expect([r.stdout.split("\n")[0], r.status]).toEqual(["removed stale mutant state of src/calc.ts", 1]);
    const third = calcRepo();
    leftover(third, { original_sha256: "b".repeat(64) });
    const kept = mutant(third, ...SURVIVES);
    expect([kept.status, kept.stdout.includes("target changed after the mutant process died; original kept at"), existsSync(join(third, LOCK, "calc.ts.orig"))]).toEqual([2, true, true]);
    const broken = calcRepo();
    write(broken, `${LOCK}/owner.json`, "{not json");
    const unread = mutant(broken, ...SURVIVES);
    expect([unread.status, unread.stdout.includes(`MUTANT ERROR: malformed mutant state ${join(broken, LOCK, "owner.json")}`), existsSync(join(broken, LOCK, "owner.json"))]).toEqual([2, true, true]);
  }, 60_000);

  test("a leftover owner.json that points outside the repo or names another repo: nothing written, state kept, exit 2", () => {
    const outside = tmp();
    const victim = join(outside, "victim.ts");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const cases = [
      (repo: string) => ({ file: relative(repo, victim), repo }),
      (repo: string) => ({ file: victim, repo }),
      (repo: string) => ({ file: "src/calc.ts", repo: outside }),
    ];
    for (const owner of cases) {
      const repo = calcRepo();
      writeFileSync(victim, "mutant bytes\n");
      const current = owner(repo).file === "src/calc.ts" ? ADD_NEG : "mutant bytes\n";
      write(repo, `${LOCK}/${owner(repo).file.split("/").pop()}.orig`, "original bytes\n");
      write(repo, `${LOCK}/owner.json`, JSON.stringify({ pid: deadPid(), started_at: new Date().toISOString(), original_sha256: hash("original bytes\n"), mutant_sha256: hash(current), ...owner(repo) }));
      const r = mutant(repo, ...SURVIVES);
      expect([r.status, r.stdout.startsWith("MUTANT ERROR: "), readFileSync(victim, "utf8"), read(repo, "src/calc.ts"), existsSync(join(repo, LOCK, "owner.json"))]).toEqual([2, true, "mutant bytes\n", ADD_NEG, true]);
    }
  }, 60_000);

  test("a second mutant while one runs: MUTANT ERROR with the pid; a live pid holds the lock at any age", async () => {
    const repo = calcRepo(secondRun("sleep 30"));
    const before = sha(repo);
    const first = qualityAsync(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find=a + b", "--replace=a - b"]);
    await until(() => sha(repo) !== before);
    const mutated = sha(repo);
    const second = mutant(repo, ...SURVIVES);
    expect([second.status, second.stdout.trim(), sha(repo)]).toEqual([2, `MUTANT ERROR: another mutant is running (pid ${first.child.pid})`, mutated]);
    first.child.kill("SIGTERM");
    expect([(await first.done).status, sha(repo)]).toEqual([143, before]);
    const old = calcRepo();
    leftover(old, { pid: process.pid, started_at: "2000-01-01T00:00:00.000Z" });
    const live = mutant(old, ...SURVIVES);
    expect([live.status, live.stdout.trim()]).toEqual([2, `MUTANT ERROR: another mutant is running (pid ${process.pid})`]);
  }, 60_000);

  test("a failed restore write: MUTANT ERROR naming the .orig, exit 2; the mutant, .orig and lock stay", async () => {
    const repo = calcRepo();
    const o = buildOpts(readArgs(["mutant", "--repo", repo]));
    let writes = 0;
    const fs = {
      writeFile: (path: string, bytes: Buffer) => {
        if (++writes > 1) throw new Error("disk full");
        writeFileSync(path, bytes);
      },
    };
    const r = await runMutant(o, { file: "src/calc.ts", find: "a + b", replace: "a - b", tests: [] }, fs);
    const orig = join(repo, LOCK, "calc.ts.orig");
    expect([r.code, r.line]).toEqual([2, `MUTANT ERROR: restore failed, original at ${orig}`]);
    expect([read(repo, "src/calc.ts"), readFileSync(orig, "utf8"), existsSync(join(repo, LOCK, "owner.json"))]).toEqual([ADD_NEG.replace("a + b", "a - b"), ADD_NEG, true]);
  }, 60_000);
});
