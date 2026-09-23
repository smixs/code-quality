import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { adapterChecks } from "./adapter-tools.ts";
import { buildOpts, readArgs } from "./config.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = join(root, ".scratch");
const script = join(root, "scripts/quality.ts");
const evidence = join(scratch, "task");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function checkSource(source: string) {
  mkdirSync(scratch, { recursive: true });
  const repo = mkdtempSync(join(scratch, "r3-inline-"));
  dirs.push(repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeFileSync(join(repo, ".quality.toml"), '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n');
  writeFileSync(join(repo, "package.json"), '{"name":"inline-config-test","private":true}\n');
  const env = { ...process.env, HOME: join(repo, ".scratch/home"), CODE_QUALITY_HOME: join(repo, ".scratch/code-quality-home") };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-q");
  git("add", ".gitignore", ".quality.toml", "package.json");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  writeFileSync(join(repo, "src/value.ts"), source);
  git("add", "src/value.ts");
  return spawnSync("bun", [script, "check", "--repo", repo, "--staged", "--no-deps"], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
}

for (const file of ["evidence-eslint-disable-codex.ts", "evidence-eslint-disable-next-line.ts"]) {
  test(`${file} reports complexity 13 and GATE FAIL`, () => {
    const result = checkSource(readFileSync(join(evidence, file), "utf8"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GATE FAIL");
    expect(result.stdout).toContain("complexity 13 > 10");
  }, 120_000);
}

test("inline eslint-disable cannot suppress a form rule", () => {
  const source = "// eslint-disable-next-line max-params\nexport function many(a: number, b: number, c: number, d: number, e: number, f: number) { return a + b + c + d + e + f; }\n";
  const result = checkSource(source);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("form/max-params");
}, 120_000);

test("ast-grep-ignore cannot suppress a gate rule", () => {
  const source = "export function swallow() {\n  try { throw new Error('x'); }\n  // ast-grep-ignore: empty-catch\n  catch (_error) {}\n}\n";
  const result = checkSource(source);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("ast/empty-catch");
}, 120_000);

test("Python form findings survive noqa", () => {
  const repo = mkdtempSync(join(scratch, "r3-noqa-"));
  dirs.push(repo);
  writeFileSync(join(repo, "pyproject.toml"), '[project]\nname = "inline-config-test"\nversion = "0.1.0"\n');
  writeFileSync(join(repo, "value.py"), "def value():\n    return missing_name  # noqa: F821\n");
  const initialized = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
  expect(initialized.status).toBe(0);
  const o = buildOpts(readArgs(["check", "--repo", repo, "--all", "--no-deps"]));
  const result = adapterChecks(o, ["form"], { roots: o.langs.filter((item) => item.adapter.id === "py") });
  expect(result.flatMap((item) => item.findings.map((finding) => finding.rule))).toContain("form/F821");
}, 120_000);

test("a new suppression comment fails the gate even when the function is simple", () => {
  const result = checkSource("// eslint-disable complexity\nexport function simple(n: number) { return n + 1; }\n");
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("tamper/inline-suppression");
}, 120_000);
