import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scratch = resolve(import.meta.dir, "../../.scratch");
mkdirSync(scratch, { recursive: true });
const sandbox = mkdtempSync(join(scratch, "grok-hooks-test-"));
const script = resolve(import.meta.dir, "../quality.ts");
const root = resolve(import.meta.dir, "../..");
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function run(command: string, env: Record<string, string>) {
  return spawnSync("bun", [script, command], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
}

describe("Grok global hook installation", () => {
  test("installs both hooks at the current root, repeats safely, and removes only its file", () => {
    const home = join(sandbox, "home");
    const grokHome = join(sandbox, "override-grok");
    const env = { HOME: home, CODE_QUALITY_HOME: join(sandbox, "cq"), GROK_HOME: grokHome };
    const hooks = join(grokHome, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "other.json"), "{}\n");
    const installed = run("install-grok-hooks", env);
    expect(installed.status).toBe(0);
    const file = join(hooks, "code-quality.json");
    const before = readFileSync(file, "utf8");
    const data = JSON.parse(before);
    expect(data.hooks.Stop[0].hooks[0].command).toBe(`bun '${script}' agent-stop`);
    expect(data.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe(`bun '${script}' guard-bash`);
    expect(run("install-grok-hooks", env).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(run("uninstall-grok-hooks", env).status).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(hooks, "other.json"))).toBe(true);
    expect(run("uninstall-grok-hooks", env).status).toBe(0);
  });

  test("uses HOME/.grok by default", () => {
    const home = join(sandbox, "default-home");
    const env = { HOME: home, CODE_QUALITY_HOME: join(sandbox, "cq-default"), GROK_HOME: "" };
    expect(run("install-grok-hooks", env).status).toBe(0);
    expect(existsSync(join(home, ".grok/hooks/code-quality.json"))).toBe(true);
  });
});
