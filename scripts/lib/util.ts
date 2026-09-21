// Shared process and git helpers. No policy here.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export type Finding = { rule: string; file: string; line: number; msg: string };
export type Check = { name: string; findings: Finding[]; error: string; note: string; notices: string[] };
export type BypassSource = "commit-msg" | "allow.md" | "inline";

export function run(cmd: string, args: string[], cwd: string, opts: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 30, ...opts });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: errText(r) };
}

const errText = (r: { error?: Error; stderr?: string | null }) => (r.error ? String(r.error) : (r.stderr ?? ""));

export function git(repo: string, ...args: string[]) {
  const r = run("git", args, repo);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err.trim()}`);
  return r.out;
}

// Commands that print paths must not turn non-ASCII names into C-style octal escapes.
export const gitPaths = (repo: string, ...args: string[]) => git(repo, "-c", "core.quotePath=false", ...args);

// git 2.55 no longer resolves the empty tree hash without the object, so write it (idempotent) first.
export const emptyTree = (repo: string) => git(repo, "hash-object", "-t", "tree", "-w", "/dev/null").trim();

export const lines = (s: string) => s.split("\n").filter(Boolean);

export const splitList = (xs: string[]) => xs.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);

export function refuse(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// A worktree shares one baseline with its main checkout; a plain repo is its own main checkout.
export function mainCheckout(repo: string) {
  return dirname(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
}

export const check = (name: string, findings: Finding[], error = "", note = ""): Check => ({ name, findings, error, note, notices: [] });

export const notedCheck = (name: string, findings: Finding[], note: string, notices: string[]): Check => ({ name, findings, error: "", note, notices });

export const findingLine = (f: Finding) => `${f.rule}  ${f.file}:${f.line}  ${f.msg}`;

export const bypassNote = (rule: string, source: BypassSource, reason: string) => `note: bypass ${rule} ${source} ${reason}`;

export function globMatch(globs: string[], file: string) {
  return globs.some((g) => new Bun.Glob(g).match(file));
}
