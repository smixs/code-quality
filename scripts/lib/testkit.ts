// Fixture repos for the spawned tests of check --tests and mutant (accept.test.ts, mutant.test.ts).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SCRIPT = join(import.meta.dir, "../quality.ts");
const dirs: string[] = [];
export const cleanup = () => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));

export function tmp(prefix = "qg-lane-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const home = tmp("qg-lane-home-");
// QG_TEST_LOADAVG=0 = no load wait; the load tests set their own value.
export const laneEnv = (extra: Record<string, string> = {}) => ({ ...process.env, CODE_QUALITY_HOME: home, QG_TEST_LOADAVG: "0", ...extra });

export function write(repo: string, file: string, text: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}

export const read = (repo: string, file: string) => readFileSync(join(repo, file), "utf8");

export function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export function commit(repo: string, message = "change") {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message);
}

export const TOML = '[project]\nlanguage = "ts"\nsrc = ["src"]\nbase = "HEAD"\n\n[security]\ngitleaks = false\naudit = false\n';

// A node repo (package.json, so node --test) with its first commit; `tests` = extra [tests] lines.
export function nodeRepo(files: Record<string, string>, tests = "", packageJson = true) {
  const repo = tmp();
  git(repo, "init", "-q");
  write(repo, ".gitignore", ".scratch/\n");
  if (packageJson) write(repo, "package.json", '{"name":"lane","private":true,"type":"module"}\n');
  write(repo, ".quality.toml", `${TOML}${tests ? `\n[tests]\n${tests}\n` : ""}`);
  for (const [file, text] of Object.entries(files)) write(repo, file, text);
  commit(repo, "initial");
  return repo;
}

export const ADD = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
export const ADD_NEG = "export function add(a: number, b: number) {\n  if (a < 0) return b;\n  return a + b;\n}\n";
export const nodeTest = (...cases: string[]) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.ts";\n${cases.join("\n")}\n`;
export const ADD_TEST = 'test("add", () => assert.equal(add(1, 2), 3));';
export const NEG_TEST = 'test("neg", () => assert.equal(add(-1, 2), 2));';

export type Run = { status: number | null; stdout: string; stderr: string };

export function quality(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: laneEnv(env) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// A running quality.ts, for signals and concurrency.
export function qualityAsync(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: laneEnv(env) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<Run>((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  return { child, done };
}

export async function until(ok: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}
