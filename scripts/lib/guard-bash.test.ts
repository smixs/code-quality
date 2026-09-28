import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { flagResult, stopNote } from "../../adapters/invoke.ts";
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
  ]) test(`flags ${command}`, () => expect(bypassReason(command)).not.toBe(""));

  for (const command of [
    "git commit -m '--no-verify'", "git commit -m 'git config core.hooksPath /tmp'",
    "git commit --message=--no-verify", "echo 'git commit -n'", "# git push --no-verify",
    "git commit -- -n", "git push origin -- --no-verify",
    "printf '%s' 'git -c core.hooksPath=x commit'", "git status",
    "git commit -mn", "git commit -m -n", "git commit -can", "git commit -C -n",
  ]) test(`does not flag ${command}`, () => expect(bypassReason(command)).toBe(""));

  test("camelCase input gets a red flag, never a denial; flag_bypass or block_bypass = false silences it", () => {
    const { repo, env, run } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nflag_bypass = true\n");
    const flagged = run();
    const out = JSON.parse(flagged.stdout);
    expect([flagged.status, out.hookSpecificOutput.permissionDecision, out.hookSpecificOutput.hookEventName, out.systemMessage === out.hookSpecificOutput.additionalContext]).toEqual([0, undefined, "PreToolUse", true]);
    expect(out.systemMessage).toStartWith("RED FLAG: git commit --no-verify skips verification hooks -- the quality hooks do not run");
    expect(out.systemMessage).toContain("; check: is skipping them intended?");
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nflag_bypass = false\n");
    expect([run().status, run().stdout.trim()]).toEqual([0, "{}"]);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = false\n");
    expect([run().status, run().stdout.trim()]).toEqual([0, "{}"]);
  });

  test("core.hooksPath gets its own danger line", () => {
    const { repo, env, run } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    writeFileSync(join(repo, ".quality.toml"), "");
    expect(JSON.parse(run("git config core.hooksPath /tmp/empty").stdout).systemMessage).toContain("the quality hooks stop running here, for every later commit and push");
  });

  test("says nothing without a configured Git repository", () => {
    const { repo, env, run } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    const unconfigured = run();
    expect([unconfigured.status, unconfigured.stdout.trim()]).toEqual([0, "{}"]);
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = true\n");
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toStartWith("RED FLAG: ");
  });

  test("says nothing in a non-Git directory even if it has .quality.toml", () => {
    const { repo, run } = fixture();
    writeFileSync(join(repo, ".quality.toml"), "[hooks]\nblock_bypass = true\n");
    const outside = run();
    expect([outside.status, outside.stdout.trim()]).toEqual([0, "{}"]);
  });

  test("pi and omp adapters: the red flag goes in front of the command's result; the Stop note comes inline, nothing is held", async () => {
    const { repo, env } = fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status).toBe(0);
    writeFileSync(join(repo, ".quality.toml"), "");
    const home = process.env.CODE_QUALITY_HOME;
    process.env.CODE_QUALITY_HOME = env.CODE_QUALITY_HOME;
    try {
      const output = [{ type: "text", text: "[main 1a2b3c] fix" }];
      const flagged = await flagResult(repo, { command: "git commit -n -m fix" }, output);
      expect([flagged?.content.length, flagged?.content[0].text.startsWith("RED FLAG: git commit -n skips verification hooks"), flagged?.content[1]]).toEqual([2, true, output[0]]);
      expect(await flagResult(repo, { command: "git commit -m fix" }, output)).toBeUndefined();
      const note = await stopNote(repo, "adapter-session");
      expect([note.startsWith("code-quality report for "), note.includes("the turn was not held"), await stopNote(repo, "adapter-session")]).toEqual([true, true, ""]);
    } finally {
      process.env.CODE_QUALITY_HOME = home;
    }
  }, 60_000);
});
