// The built-in coverage commands append to $QG_LCOV: records a test's child process appended survive,
// and the full gate checks the lcov structure before any CRAP number. Spawned: bun scripts/quality.ts ...
import { afterAll, describe, expect, test } from "bun:test";
import { cleanup, commit, nodeRepo, quality, read, TOML, write } from "./testkit.ts";

afterAll(cleanup);

const OUT = ".scratch/quality";
const X = "export const x = 1;\n";
const CALC = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
// A shell line a test runs in a child process: one SF record for `file` appended to $QG_LCOV.
const appendLine = (file: string) => `printf 'SF:${file}\\\\nDA:1,1\\\\nend_of_record\\\\n' >> "$QG_LCOV"`;
const childTest = (runner: "bun" | "node", file: string, pass = true) => [
  runner === "bun" ? 'import { test } from "bun:test";' : 'import { test } from "node:test";',
  'import { execSync } from "node:child_process";',
  `import { add } from "${runner === "bun" ? "../src" : "."}/calc.ts";`,
  `test("a child process appends coverage", () => {\n  execSync(\`${appendLine(file)}\`);\n  if (add(1, 2) !== ${pass ? 3 : 4}) throw new Error("red");\n});`,
  "",
].join("\n");
const checkTests = (repo: string) => quality(["check", "--repo", repo, "--since", "HEAD~1", "--tests", "--no-deps"]);
const fullGate = (repo: string) => quality(["--repo", repo, "--no-deps"]);
const records = (repo: string, file: string) => read(repo, `${OUT}/lcov.info`).split("\n").filter((line) => line === `SF:${file}` || line.endsWith(`/${file}`) && line.startsWith("SF:")).length;

// A changed src/x.ts that only the child's record covers; the test is named x.test.ts beside it.
function touchedRepo(runner: "bun" | "node", pass = true) {
  const test = childTest(runner, "src/x.ts", pass).replace("../src/calc.ts", "./calc.ts");
  const repo = nodeRepo({ "src/calc.ts": CALC, "src/x.ts": X, "src/x.test.ts": test }, "", runner === "node");
  write(repo, "src/x.ts", "export const x = 2;\n");
  commit(repo);
  return repo;
}

describe("built-in coverage commands append to $QG_LCOV", () => {
  test("bun touched run: the record a test's child appended covers src/x.ts, CLEAN", () => {
    const r = checkTests(touchedRepo("bun"));
    expect([r.status, r.stdout.includes("bun test"), r.stdout.includes("without lcov data"), /^CLEAN$/m.test(r.stdout)]).toEqual([0, true, false, true]);
  }, 60_000);

  test("node touched run: the child's record is kept, CLEAN", () => {
    const r = checkTests(touchedRepo("node"));
    expect([r.status, r.stdout.includes("node --test"), r.stdout.includes("without lcov data"), /^CLEAN$/m.test(r.stdout)]).toEqual([0, true, false, true]);
  }, 60_000);

  test("bun full gate (bun test scripts/): the child's record is in lcov.info", () => {
    const repo = nodeRepo({ "src/calc.ts": CALC, "src/x.ts": X, "scripts/x.test.ts": childTest("bun", "src/x.ts") }, "", false);
    fullGate(repo);
    expect([records(repo, "src/x.ts"), records(repo, "src/calc.ts")]).toEqual([1, 1]);
  }, 60_000);

  test("node full gate: the child's record is in lcov.info", () => {
    const repo = nodeRepo({ "src/calc.ts": CALC, "src/x.ts": X, "src/x.test.ts": childTest("node", "src/x.ts") });
    fullGate(repo);
    expect([records(repo, "src/x.ts"), records(repo, "src/calc.ts")]).toEqual([1, 1]);
  }, 60_000);

  test("pytest touched run (uv with pytest-cov): the child's record for src/x.py is kept, CLEAN", () => {
    const pyTest = `import subprocess\n\n\ndef test_child():\n    subprocess.run(["sh", "-c", ${JSON.stringify(appendLine("src/x.py").replaceAll("\\\\", "\\"))}], check=True)\n`;
    const repo = nodeRepo({ "src/x.py": "x = 1\n", "src/test_x.py": pyTest }, "", false);
    write(repo, ".quality.toml", TOML.replace('language = "ts"', 'language = "py"'));
    commit(repo, "py");
    write(repo, "src/x.py", "x = 2\n");
    commit(repo);
    const r = checkTests(repo);
    expect([r.status, r.stdout.includes("pytest"), r.stdout.includes("without lcov data"), /^CLEAN$/m.test(r.stdout)]).toEqual([0, true, false, true]);
  }, 180_000);

  test("tests red: the exit code of the tests, tests/red, never exit 0 from the append step", () => {
    const r = checkTests(touchedRepo("bun", false));
    expect([r.status, /tests: 1 touched test file\(s\) red \(1 failed, exit 1\)/.test(r.stdout), r.stdout.includes("tests/red")]).toEqual([1, true, true]);
  }, 60_000);

  test("pytest full gate (uv with pytest-cov): the child's record for src/x.py is in lcov.info", () => {
    const pyTest = `import subprocess\n\n\ndef test_child():\n    subprocess.run(["sh", "-c", ${JSON.stringify(appendLine("src/x.py").replaceAll("\\\\", "\\"))}], check=True)\n`;
    const repo = nodeRepo({ "src/x.py": "x = 1\n", "tests/test_x.py": pyTest }, "", false);
    write(repo, ".quality.toml", TOML.replace('language = "ts"', 'language = "py"'));
    commit(repo, "py");
    fullGate(repo);
    expect(read(repo, `${OUT}/lcov.info`)).toContain("SF:src/x.py\nDA:1,1\nend_of_record\n");
  }, 180_000);

  test("lcov.info of an earlier full run is not counted: two runs, no stale or doubled records", () => {
    const repo = nodeRepo({ "src/calc.ts": CALC, "src/x.ts": X, "src/x.test.ts": childTest("node", "src/x.ts") });
    fullGate(repo);
    const first = [records(repo, "src/x.ts"), records(repo, "src/calc.ts")];
    write(repo, "src/x.test.ts", childTest("node", "src/x.ts").replace(/ {2}execSync\(.*\);\n/, ""));
    commit(repo, "no child");
    fullGate(repo);
    expect([...first, records(repo, "src/x.ts"), records(repo, "src/calc.ts")]).toEqual([1, 1, 0, 1]);
  }, 90_000);
});

describe("the full gate checks the lcov structure", () => {
  test("a DA after end_of_record: tests: ERROR invalid coverage, exit 1, no CRAP number", () => {
    const repo = nodeRepo({ "src/calc.ts": CALC });
    const cmd = `printf 'SF:src/calc.ts\\nDA:2,1\\nend_of_record\\nDA:1,1\\n' > "$QG_LCOV"`;
    write(repo, ".quality.toml", TOML.replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = '''${cmd}'''`));
    commit(repo, "cmd");
    const r = fullGate(repo);
    const report = read(repo, `${OUT}/report.md`);
    expect([r.status, /^tests: ERROR invalid coverage at \S+lcov\.info, see \S+tests\.log$/m.test(r.stdout), r.stdout.includes("invalid coverage (CRAP and mean not judged"), /cov \d+%/.test(report), /CRAP \d/.test(report)]).toEqual([1, true, true, false, false]);
  }, 60_000);
});

// Version 2: end_of_record only as the exact line and only inside an open record.
describe("the lcov terminator (full gate, plain check, --skip-tests)", () => {
  const BROKEN: [string, string][] = [
    ["an orphan end_of_record before the first SF", "end_of_record\\nSF:src/calc.ts\\nDA:1,1\\nend_of_record\\n"],
    ["a second terminator", "SF:src/calc.ts\\nDA:1,1\\nend_of_record\\nend_of_record\\n"],
    ["end_of_recordX", "SF:src/calc.ts\\nDA:1,1\\nend_of_recordX\\n"],
  ];
  const INVALID = /^tests: ERROR invalid coverage at \S+lcov\.info, see \S+tests\.log$/m;
  for (const [name, lcov] of BROKEN) {
    test(`${name}: invalid coverage, exit 1, in each`, () => {
      const repo = nodeRepo({ "src/calc.ts": CALC });
      write(repo, ".quality.toml", TOML.replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = '''printf '${lcov}' > "$QG_LCOV"'''`));
      commit(repo, "cmd");
      write(repo, "src/calc.ts", CALC.replace("a + b", "b + a"));
      commit(repo, "change");
      const full = fullGate(repo);
      const plain = quality(["check", "--repo", repo, "--since", "HEAD~1", "--no-deps"]);
      const skip = quality(["--repo", repo, "--no-deps", "--skip-tests"]);
      expect([full, plain, skip].map((r) => [r.status, INVALID.test(r.stdout)])).toEqual([[1, true], [1, true], [1, true]]);
    }, 90_000);
  }
});
