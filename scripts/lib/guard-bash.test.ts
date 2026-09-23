import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bypassReason } from "./guard-bash.ts";

const SCRIPT = join(import.meta.dir, "../quality.ts");
const scratch = resolve(import.meta.dir, "../../.scratch");
mkdirSync(scratch, { recursive: true });

function fixture() {
  const repo = mkdtempSync(join(scratch, "guard-test-"));
  const env = { ...process.env, HOME: join(repo, "home"), CODE_QUALITY_HOME: join(repo, "cq"), GROK_HOME: join(repo, "grok") };
  const run = (command = "git commit --no-verify -m fix") => spawnSync("bun", [SCRIPT, "guard-bash"], {
    cwd: repo, env, encoding: "utf8",
    input: JSON.stringify({ cwd: repo, toolName: "Bash", toolInput: { command }, hookEventName: "PreToolUse" }),
  });
  return { repo, env, run };
}

describe("guard-bash", () => {
  for (const command of [
    "git commit --no-verify -m fix", "git commit -n -m fix", "git push --no-verify origin main",
    "git -c core.hooksPath=/tmp/empty commit -m fix", "git -ccore.hooksPath=/tmp/empty push",
    "git config core.hooksPath /tmp/empty", "git config --unset core.hooksPath",
    "echo ok && git commit --no-verify -m fix",
    "FOO=1 git commit --no-verify -m fix", "HUSKY=0 git push --no-verify origin main",
    "FOO=1 HUSKY=0 git -c core.hooksPath=/tmp/empty commit -m fix",
    "git commit -nm fix", "git commit -anm fix", "git commit -anF message.txt",
  ]) test(`rejects ${command}`, () => expect(bypassReason(command)).not.toBe(""));

  for (const command of [
    "git commit -m '--no-verify'", "git commit -m 'git config core.hooksPath /tmp'",
    "git commit --message=--no-verify", "echo 'git commit -n'", "# git push --no-verify",
    "git commit -- -n", "git push origin -- --no-verify",
    "printf '%s' 'git -c core.hooksPath=x commit'", "git status",
    "git commit -mn", "git commit -m -n", "git commit -can", "git commit -C -n",
  ]) test(`allows ${command}`, () => expect(bypassReason(command)).toBe(""));

  test("camelCase input denies and [hooks] block_bypass=false allows", () => {
    const { repo, env, run } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = true\n");
    const denied = run();
    expect([denied.status, JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision]).toEqual([2, "deny"]);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = false\n");
    const allowed = run();
    expect([allowed.status, allowed.stdout.trim()]).toEqual([0, "{}"]);
  });

  test("allows bypass commands without a configured Git repository", () => {
    const { repo, env, run } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    const unconfigured = run();
    expect([unconfigured.status, unconfigured.stdout.trim()]).toEqual([0, "{}"]);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = true\n");
    expect(JSON.parse(run().stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows a non-Git directory even if it has .quality.toml", () => {
    const { repo, run } = fixture();
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = true\n");
    const outside = run();
    expect([outside.status, outside.stdout.trim()]).toEqual([0, "{}"]);
  });
});
