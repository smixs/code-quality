import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpts, readArgs } from "./config.ts";
import { functionsOf, parseLizardCsv, parseRadonJson, score, sourceFiles } from "./crap.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("language-independent CRAP", () => {
  test("parses the documented Lizard 1.24 CSV columns", () => {
    const csv = '7,12,93,2,18,"choose@4-21@src/a.go","src/a.go","choose","choose x,y",4,21\n';
    expect(parseLizardCsv(csv)).toEqual([expect.objectContaining({ file: "src/a.go", name: "choose", cc: 12, start: 4, end: 21 })]);
  });

  test("computes function coverage from DA lines intersecting the Lizard range without FN records", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-crap-"));
    dirs.push(repo);
    const lcov = join(repo, "lcov.info");
    writeFileSync(lcov, "SF:src/a.go\nDA:2,1\nDA:3,1\nDA:4,0\nend_of_record\n");
    const fns = parseLizardCsv('4,2,20,1,4,"choose@2-5@src/a.go","src/a.go","choose","choose x",2,5\n');
    score(fns, { lcov, code: 0, failed: 0, skipped: false, red: false, used: true }, repo);
    expect([fns[0].cov, fns[0].crap]).toEqual([0.5, 2.5]);
  });

  test("parses Radon function ranges and nested closures", () => {
    const repo = "/tmp/qg-radon";
    const output = JSON.stringify({
      "src/value.py": [{
        type: "function", name: "outer", lineno: 2, endline: 8, col_offset: 0, complexity: 4,
        closures: [{ type: "closure", name: "inner", lineno: 4, endline: 5, col_offset: 2, complexity: 2, closures: [] }],
      }],
    });
    expect(parseRadonJson(output, repo).map(({ file, name, cc, start, end, nested }) => ({ file, name, cc, start, end, nested }))).toEqual([
      { file: "src/value.py", name: "outer", cc: 4, start: 2, end: 8, nested: [[4, 5]] },
      { file: "src/value.py", name: "inner", cc: 2, start: 4, end: 5, nested: [] },
    ]);
  });

  test("indexes Go and Rust functions in the same repository through Lizard", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-crap-"));
    dirs.push(repo);
    mkdirSync(join(repo, "go"));
    mkdirSync(join(repo, "rust/src"), { recursive: true });
    writeFileSync(join(repo, "go/go.mod"), "module example.test/go\n");
    writeFileSync(join(repo, "go/main.go"), "package main\nfunc goValue(x int) int { if x > 0 { return x }; return 0 }\n");
    writeFileSync(join(repo, "rust/Cargo.toml"), "[package]\nname='sample'\nversion='0.1.0'\n");
    writeFileSync(join(repo, "rust/src/lib.rs"), "pub fn rust_value(x: i32) -> i32 { if x > 0 { x } else { 0 } }\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const o = buildOpts(readArgs(["check", "--repo", repo, "--all", "--no-deps"]));
    const result = functionsOf(o, sourceFiles(o));
    expect(result.failed).toEqual([]);
    expect(result.fns.map((fn) => `${fn.file}:${fn.name}`).toSorted()).toEqual([
      "go/main.go:goValue", "rust/src/lib.rs:rust_value",
    ]);
  }, 60_000);

  test("keeps ESLint as the TypeScript complexity source when Lizard disagrees", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-ts-native-"));
    dirs.push(repo);
    writeFileSync(join(repo, "package.json"), '{"name":"native-cc","private":true}\n');
    writeFileSync(join(repo, "value.ts"), `
type Options = { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };
function wiring(options: Options) {
  return {
    a: options.a ?? 1,
    b: options.b ?? 2,
    c: options.c ?? 3,
    d: options.d ?? 4,
    e: options.e ?? 5,
    f: options.f ?? (() => 6)(),
  };
}
`);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const o = buildOpts(readArgs(["check", "--repo", repo, "--all", "--no-deps"]));
    const result = functionsOf(o, sourceFiles(o));
    const wiring = result.fns.find((fn) => fn.name.includes("wiring"));
    expect(wiring?.cc).toBeLessThanOrEqual(10);
  }, 60_000);

  test("keeps non-ASCII staged paths in the complexity input", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-unicode-path-"));
    dirs.push(repo);
    mkdirSync(join(repo, "src/データ"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"unicode-path","private":true}\n');
    writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage="ts"\nsrc=["src"]\n');
    const risky = `export function risky(value: number) {
  if (value > 0) value++;
  if (value > 1) value++;
  if (value > 2) value++;
  if (value > 3) value++;
  if (value > 4) value++;
  if (value > 5) value++;
  if (value > 6) value++;
  if (value > 7) value++;
  if (value > 8) value++;
  if (value > 9) value++;
  if (value > 10) value++;
  return value;
}\n`;
    writeFileSync(join(repo, "src/ascii.ts"), risky);
    writeFileSync(join(repo, "src/データ/f.ts"), risky);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    Bun.spawnSync(["git", "config", "core.quotePath", "true"], { cwd: repo });
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    const o = buildOpts(readArgs(["check", "--repo", repo, "--staged", "--no-deps"]));
    const result = functionsOf(o, sourceFiles(o));
    expect(result.fns.filter((fn) => fn.cc > 10).map((fn) => fn.file).toSorted()).toEqual([
      "src/ascii.ts", "src/データ/f.ts",
    ]);
  }, 60_000);

  test("falls back to Lizard per file when the native analyzer is unavailable", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-ts-fallback-"));
    dirs.push(repo);
    writeFileSync(join(repo, "package.json"), '{"name":"fallback-cc","private":true}\n');
    writeFileSync(join(repo, "value.ts"), "export function value() { return 1; }\n");
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const o = buildOpts(readArgs(["check", "--repo", repo, "--all", "--no-deps"]));
    const csv = '1,1,1,0,1,"value@1-1@value.ts","value.ts","value","value()",1,1\n';
    const result = functionsOf(o, sourceFiles(o), {
      loadEslint: () => { throw new Error("eslint unavailable"); },
      run: () => ({ code: 0, out: csv, err: "" }),
    });
    expect(result.failed).toEqual(["crap: lizard fallback for value.ts"]);
    expect(result.fns).toEqual([expect.objectContaining({ file: "value.ts", name: "value", cc: 1 })]);
  });
});
