import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpts, readArgs } from "./config.ts";
import { analyze, gate } from "./gate.ts";

const SCRIPT = join(import.meta.dir, "../quality.ts");
const FIXTURES = join(import.meta.dir, "../fixtures/lang");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// Every run of quality.ts moves the plugin pointers in CODE_QUALITY_HOME; never the real ones.
const home = mkdtempSync(join(tmpdir(), "qg-lang-home-"));
dirs.push(home);

function fixtureRepo(language: string) {
  const repo = mkdtempSync(join(tmpdir(), `qg-${language}-`));
  dirs.push(repo);
  cpSync(join(FIXTURES, language), repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "-A"], { cwd: repo });
  return repo;
}

describe("language fixtures", () => {
  for (const language of ["go", "rust", "java", "php", "ruby"]) {
    test(`${language}: gate finds complexity, duplication, skipped test, and secret`, () => {
      const repo = fixtureRepo(language);
      const o = buildOpts(readArgs(["check", "--repo", repo, "--all", "--src", ".", "--no-deps"]));
      const result = gate(o, analyze(o, "fresh-or-none"));
      const rules = result.checks.flatMap((item) => item.findings.map((finding) => finding.rule));
      expect(rules).toContain("crap");
      expect(rules).toContain("dup/jscpd");
      expect(rules).toContain("tamper/test-skipped");
      expect(rules).toContain("secret/token");
    }, 60_000);
  }

  test("missing universal tools print not run and leave a clean fixture green", () => {
    const repo = mkdtempSync(join(tmpdir(), "qg-clean-go-"));
    dirs.push(repo);
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
    writeFileSync(join(repo, "go.mod"), "module example.test/clean\n");
    writeFileSync(join(repo, "pkg/value.go"), "package pkg\nfunc Value() int { return 1 }\n");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["add", "-A"], { cwd: repo });
    const result = spawnSync(process.execPath, [SCRIPT, "check", "--repo", repo, "--all", "--src", ".", "--no-deps"], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin", CODE_QUALITY_HOME: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not run: crap/cc");
    expect(result.stdout).toContain("dup/jscpd: not run");
    expect(result.stdout).toContain("ast/go: not run");
    expect(result.stdout).toContain("security/semgrep: not run");
    expect(result.stdout).toContain("not run: form/gocyclo (gocyclo not found: go install github.com/fzipp/gocyclo/cmd/gocyclo@latest; roots: 1)");
    expect(result.stdout).not.toContain("not wired");
  }, 60_000);
});
