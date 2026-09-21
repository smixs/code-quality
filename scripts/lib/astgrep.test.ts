import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astCheck, semgrepCheck } from "./astgrep.ts";
import { buildOpts, readArgs } from "./config.ts";
import { sourceFiles } from "./crap.ts";
import { changes } from "./diff.ts";
import { dupCheck } from "./dup.ts";
import type { run } from "./util.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "qg-ast-"));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  return root;
}

describe("language-independent structural tools", () => {
  test("ast-grep finds an empty Java catch through the Java adapter", () => {
    const root = repo({
      "pom.xml": "<project/>\n",
      "src/Main.java": "class Main { void run() { try { work(); } catch (Exception error) {} } void work() {} }\n",
    });
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--no-deps"]));
    expect(astCheck(o, changes(o)).findings.map((finding) => finding.rule)).toContain("ast/empty-catch");
  }, 60_000);

  test("loads empty-catch rules for every adapter whose language has catches", () => {
    const root = repo({
      ".quality.toml": '[project]\nlanguage=["ts","py","go","rust","java","kotlin","csharp","swift","php","ruby","cpp","dart"]\nsrc=["."]\n',
      "ts/package.json": "{}\n", "ts/a.ts": "function run() { try { work(); } catch (error) {} }\n",
      "py/pyproject.toml": "[project]\nname='a'\nversion='0.1.0'\n", "py/a.py": "try:\n  work()\nexcept Exception:\n  pass\n",
      "go/go.mod": "module example.test/go\n", "go/a.go": "package a\n",
      "rust/Cargo.toml": "[package]\nname='a'\nversion='0.1.0'\n", "rust/src/lib.rs": "pub fn run() {}\n",
      "java/pom.xml": "<project/>\n", "java/A.java": "class A { void run() { try { work(); } catch (Exception error) {} } void work() {} }\n",
      "kotlin/build.gradle.kts": "\n", "kotlin/A.kt": "fun run() { try { work() } catch (error: Exception) {} }\n",
      "csharp/A.csproj": "<Project/>\n", "csharp/A.cs": "class A { void Run() { try { Work(); } catch (Exception error) {} } void Work() {} }\n",
      "swift/Package.swift": "// swift-tools-version: 6.0\n", "swift/A.swift": "func run() { do { try work() } catch {} }\n",
      "php/composer.json": "{}\n", "php/a.php": "<?php function run() { try { work(); } catch (Exception $error) {} }\n",
      "ruby/Gemfile": "source 'https://rubygems.org'\n", "ruby/a.rb": "begin\n  work\nrescue StandardError\nend\n",
      "cpp/CMakeLists.txt": "project(a)\n", "cpp/a.cpp": "void run() { try { work(); } catch (const std::exception& error) {} }\n",
      "dart/pubspec.yaml": "name: a\n", "dart/a.dart": "void run() { try { work(); } catch (error) {} }\n",
    });
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--no-deps"]));
    const result = astCheck(o, changes(o));
    expect(result.error).toBe("");
    expect(result.findings.filter((finding) => finding.rule === "ast/empty-catch").map((finding) => finding.file).toSorted()).toEqual([
      "cpp/a.cpp", "csharp/A.cs", "dart/a.dart", "java/A.java", "kotlin/A.kt", "php/a.php", "py/a.py", "ruby/a.rb", "swift/A.swift", "ts/a.ts",
    ]);
    expect(result.notices.filter((notice) => notice.startsWith("ast/empty-catch: not run"))).toHaveLength(2);
  }, 60_000);

  test("documents the emitted Python empty-except rule id", () => {
    const skill = readFileSync(join(import.meta.dir, "../../SKILL.md"), "utf8");
    expect(skill).not.toContain("ast/py-empty-except");
    expect(existsSync(join(import.meta.dir, "../../rules/sg/py-empty-except.yml"))).toBe(false);
  });

  test("jscpd 5 writes jscpd-report.json and reports a Go clone", () => {
    const block = `
  if x > 0 { x += 1 }
  if x > 1 { x += 2 }
  if x > 2 { x += 3 }
  if x > 3 { x += 4 }
  if x > 4 { x += 5 }
  if x > 5 { x += 6 }
  return x
`;
    const root = repo({
      "go.mod": "module example.test/dup\n",
      "a.go": `package dup\nfunc A(x int) int {${block}}\n`,
      "b.go": `package dup\nfunc B(x int) int {${block}}\n`,
    });
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--no-deps"]));
    o.toml.thresholds.dup_min_tokens = 20;
    expect(dupCheck(o, changes(o), sourceFiles(o)).findings.map((finding) => finding.rule)).toContain("dup/jscpd");
  }, 60_000);

  test("missing optional Semgrep is an explicit non-blocking not run", () => {
    const root = repo({ "go.mod": "module example.test/clean\n", "main.go": "package clean\n" });
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--no-deps"]));
    const missing = (() => ({ code: -1, out: "", err: "spawnSync semgrep ENOENT" })) as typeof run;
    const result = semgrepCheck(o, changes(o), { run: missing });
    expect([result.findings, result.error, result.notices]).toEqual([[], "", ["security/semgrep: not run (semgrep not found; pipx install semgrep)"]]);
  });
});
