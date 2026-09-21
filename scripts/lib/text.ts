// Grep-style checks on added lines: doc links, glossary Avoid words, secrets and machine paths,
// plus the commit message check. Deterministic, no network.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Opts } from "./config.ts";
import { addedLines, type Changes, headOrEmpty } from "./diff.ts";
import { bypassNote, check, type Finding, git, gitPaths, globMatch, lines, notedCheck, run } from "./util.ts";

type Added = { file: string; line: number; text: string };

// ---- markdown helpers

function fencedLines(text: string) {
  const out = new Set<number>();
  let inside = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inside = !inside;
    else if (inside) out.add(i + 1);
  });
  return out;
}

function proseLines(o: Opts, ch: Changes, globs: string[], skip: string) {
  const all = addedLines(ch, (f) => f !== skip && globMatch(globs, f) && existsSync(join(o.repo, f)));
  const fences = new Map<string, Set<number>>();
  const fenced = (a: Added) => {
    if (!fences.has(a.file)) fences.set(a.file, fencedLines(readFileSync(join(o.repo, a.file), "utf8")));
    return fences.get(a.file)!.has(a.line);
  };
  return all.filter((a) => !a.file.endsWith(".md") || !fenced(a));
}

const spans = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

// ---- doc links: backticked paths (path, path:line) and code symbols must exist

const PATH_TOKEN = /^[\w.@-]+(\/[\w.@-]*)*(:\d+(-\d+)?)?$/;

type Ref = { a: Added; token: string };

function pathParts(token: string) {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(token)!;
  return { path: m[1].replace(/\/$/, ""), line: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : 0 };
}

// A repo path: has a slash and starts at something the repo has (`agent/x.ts`, `docs/`), or is a
// file name next to the doc (`./x.md`). Bare names (`mcp.json`) and runtime paths (`.graph/x`) are not.
function looksLikePath(o: Opts, token: string) {
  if (!PATH_TOKEN.test(token) || token.startsWith("@")) return false;
  const { path } = pathParts(token);
  return path.includes("/") && rootExists(o, path.split("/")[0]);
}

const rootExists = (o: Opts, first: string) => first === "." || first === ".." || existsSync(join(o.repo, first));

function resolvePath(o: Opts, docFile: string, path: string) {
  const cands = [join(o.repo, path), join(o.repo, dirname(docFile), path)];
  const hit = cands.find((c) => existsSync(c));
  if (hit) return hit;
  return ignored(o, path) ? "(ignored)" : "";
}

const ignored = (o: Opts, path: string) => run("git", ["check-ignore", "-q", path], o.repo).code === 0;

function pathFinding(o: Opts, r: Ref): Finding | null {
  const { path, line } = pathParts(r.token);
  const hit = resolvePath(o, r.a.file, path);
  if (!hit) return missingPath(r);
  if (!line || hit.startsWith("(")) return null;
  const count = readFileSync(hit, "utf8").split("\n").length;
  return line <= count ? null : deadLine(r, path, count);
}

const missingPath = (r: Ref): Finding => ({ rule: "doc/path", file: r.a.file, line: r.a.line, msg: `\`${r.token}\` does not exist` });
const deadLine = (r: Ref, path: string, count: number): Finding => ({ rule: "doc/line", file: r.a.file, line: r.a.line, msg: `\`${r.token}\`: ${path} has ${count} lines` });

// A code symbol: `name()` / `a.b()` or a lowerCamel identifier such as `readOpts`.
function symbolOf(token: string) {
  const call = /^([\w$.]+)\(\)$/.exec(token);
  const name = (call ? call[1] : token).split(".").pop()!;
  const ident = /^[A-Za-z_$][\w$]*$/.test(name);
  const camel = /^[a-z][a-z0-9]*[A-Z][\w$]*$/.test(name);
  return ident && (call || camel) ? name : "";
}

function knownSymbols(o: Opts, names: string[]) {
  if (!names.length) return new Set<string>();
  const args = ["grep", "-o", "-h", "-w", "-F", ...names.flatMap((n) => ["-e", n]), "--", ".", ":(exclude)*.md"];
  return new Set(lines(run("git", args, o.repo).out));
}

function symbolFindings(o: Opts, refs: Ref[]) {
  const withName = refs.map((r) => ({ r, name: symbolOf(r.token) })).filter((x) => x.name);
  const known = knownSymbols(o, [...new Set(withName.map((x) => x.name))]);
  return withName.filter((x) => !known.has(x.name)).map((x): Finding => ({ rule: "doc/symbol", file: x.r.a.file, line: x.r.a.line, msg: `\`${x.r.token}\` not found in code (git grep)` }));
}

// Docs that still point at files this change deleted or renamed away.
function brokenByChange(o: Opts): Finding[] {
  if (o.scope.kind === "all") return [];
  const gone = deletedFiles(o);
  if (!gone.length) return [];
  const docs = liveDocs(o);
  if (!docs.length) return [];
  return brokenDocLines(o, gone, docs).map(grepFinding);
}

function liveDocs(o: Opts) {
  return lines(gitPaths(o.repo, "ls-files")).filter((file) => globMatch(o.toml.docs.globs, file) && !globMatch(o.toml.docs.history_globs, file));
}

function brokenDocLines(o: Opts, gone: string[], docs: string[]) {
  const args = ["grep", "-n", "-F", ...gone.flatMap((file) => ["-e", `\`${file}`]), "--", ...docs];
  return lines(run("git", args, o.repo).out);
}

function grepFinding(l: string): Finding {
  const [file, line, ...rest] = l.split(":");
  return { rule: "doc/deleted", file, line: Number(line), msg: `points at a file this change removes: ${rest.join(":").trim().slice(0, 120)}` };
}

function deletedFiles(o: Opts) {
  const s = o.scope;
  const args = s.kind === "staged" ? ["--cached", headOrEmpty(o.repo)] : s.kind === "since" ? [s.rev, "HEAD"] : [git(o.repo, "merge-base", o.base, "HEAD").trim()];
  return lines(gitPaths(o.repo, "diff", "--name-status", "--diff-filter=DR", ...args)).map((l) => l.split("\t")[1]);
}

// History docs (ADRs, changelogs) record what was removed: a named symbol or path may be gone on purpose.
export function docCheck(o: Opts, ch: Changes) {
  const prose = proseLines(o, ch, o.toml.docs.globs, "").filter((a) => !globMatch(o.toml.docs.history_globs, a.file));
  const refs = prose.flatMap((a) => spans(a.text).map((token) => ({ a, token })));
  const paths = refs.filter((r) => looksLikePath(o, r.token)).map((r) => pathFinding(o, r));
  const symbols = symbolFindings(o, refs.filter((r) => !looksLikePath(o, r.token)));
  return check("doc", [...paths.filter((x): x is Finding => x !== null), ...symbols, ...brokenByChange(o)]);
}

// ---- glossary: Avoid words from a CONTEXT.md-style glossary

// An Avoid line with a qualifier - "(this ...)", "for ...", "as ...", guillemets - names a sense, not a word:
// the whole line is context-dependent and left to the reviewer. Plain lines give plain words.
const QUALIFIER = /[(«]|(^|\s)(для|как|без|это|не|of|for|as|when)(\s|$)/i;

export function avoidTerms(o: Opts) {
  const g = o.toml.glossary;
  if (!g.path) return [];
  const path = join(o.repo, g.path);
  if (!existsSync(path)) throw new Error(`glossary ${g.path} from ${o.cfgFile || "defaults"} does not exist`);
  const items = readFileSync(path, "utf8").split("\n").filter((l) => l.includes(g.marker)).flatMap((l) => plainItems(l.split(g.marker)[1]));
  const allow = new Set(g.allow.map((x) => x.toLowerCase()));
  return [...new Set(items)].filter((t) => !allow.has(t.toLowerCase()));
}

function plainItems(rest: string) {
  if (QUALIFIER.test(rest)) return [];
  return rest.split(",").map((x) => x.trim()).filter(Boolean);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function termRegex(terms: string[]) {
  if (!terms.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${terms.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

function termFinding(re: RegExp, a: Added): Finding | null {
  const m = re.exec(a.text);
  return m ? { rule: "glossary", file: a.file, line: a.line, msg: `Avoid word "${m[1]}"` } : null;
}

export function glossaryCheck(o: Opts, ch: Changes) {
  const re = termRegex(avoidTerms(o));
  if (!re) return check("glossary", [], "", o.toml.glossary.path ? "no terms" : "no glossary configured");
  const prose = proseLines(o, ch, o.toml.glossary.globs, o.toml.glossary.path);
  return check("glossary", prose.map((a) => termFinding(re, a)).filter((x): x is Finding => x !== null));
}

// ---- secrets and machine paths

const SECRET = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(ant-|proj-|or-v1-)?(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{24,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/,
];
// Placeholder home names are fine in docs and fixtures; anything else is somebody's machine.
const PLACEHOLDER_USERS = ["user", "username", "you", "me", "runner", "ubuntu", "node", "example", "name", "alice", "bob", "test", "john", "jane", "person", "foo"];
// Lines that carry a fake credential on purpose (fixtures of a secret scanner) say so.
const ALLOW_MARK = /(?:^|\s)(?:gitleaks|qg):allow\s+(\S.*)$/;
const SENSITIVE_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*([=:])\s*["']?[^\s"']{8,}/gi;

function machineRe(o: Opts) {
  const users = [...PLACEHOLDER_USERS, ...o.toml.secrets.allow_users].map(escapeRe).join("|");
  return new RegExp(`(?<![\\w.$])/(Users|home)/(?!(${users})/)[A-Za-z][\\w.-]*/`);
}
const ENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$)[\w-]+)?$/;
const LOCKS = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|uv\.lock)$/;

function secretFinding(machine: RegExp, a: Added): Finding | null {
  if (SECRET.some((re) => re.test(a.text))) return { rule: "secret/token", file: a.file, line: a.line, msg: "looks like a credential (mark a deliberate fixture with qg:allow)" };
  const m = machine.exec(a.text);
  return m ? { rule: "secret/machine-path", file: a.file, line: a.line, msg: `machine path ${m[0]}` } : null;
}

export function secretCheck(o: Opts, ch: Changes) {
  const env = [...ch.keys()].filter((f) => ENV_FILE.test(f)).map((f): Finding => ({ rule: "secret/env-file", file: f, line: 1, msg: "env file in the change" }));
  const added = addedLines(ch, (f) => !LOCKS.test(f) && !f.startsWith(".scratch/"));
  const machine = machineRe(o);
  const found = added.map((a) => ({ added: a, finding: secretFinding(machine, a) })).filter((x): x is { added: Added; finding: Finding } => x.finding !== null);
  const findings = found.filter((x) => !inlineAllowReason(x.added.text)).map((x) => x.finding);
  const notices = found.flatMap((x) => {
    const reason = inlineAllowReason(x.added.text);
    return reason ? [bypassNote(x.finding.rule, "inline", reason)] : [];
  });
  return notedCheck("secret", [...env, ...findings], "", notices);
}

const inlineAllowReason = (text: string) => ALLOW_MARK.exec(text)?.[1].trim() ?? "";

export function redactSensitiveText(text: string) {
  let redacted = text;
  for (const pattern of SECRET) redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "[REDACTED]");
  redacted = redacted.replace(SENSITIVE_ASSIGNMENT, (_match, key, separator) => `${key}${separator}[REDACTED]`);
  return redacted.replace(/\/(?:Users|home)\/[A-Za-z][\w.-]*\//g, "/[REDACTED]/");
}

// ---- commit message: no AI or tool attribution

const ATTRIBUTION = [
  /^[ \t]*co-authored-by:.*\b(claude|anthropic|codex|openai|chatgpt|gpt|copilot|cursor|devin|gemini|aider)\b/im,
  /generated (with|by)\b.*\b(claude|codex|chatgpt|gpt|copilot|cursor|gemini|ai)\b/i,
  /🤖/u,
  /\b(written|created|authored|made|assisted|produced|co-written) (with|by|via) (claude( code)?|codex|chatgpt|copilot)\b/i,
  /\b(with ai assistance|ai[- ]generated)\b/i,
  /noreply@anthropic\.com/i,
];

// `git commit -v` appends the diff below this line; git drops it from the message.
const SCISSORS = /^# -+ >8 -+$/m;

export function commitMsgFindings(o: Opts, text: string): Finding[] {
  const body = text.split(SCISSORS)[0].split("\n").filter((l) => !l.startsWith("#")).join("\n");
  const attr = ATTRIBUTION.filter((re) => re.test(body)).map((re): Finding => ({ rule: "commit/attribution", file: "COMMIT_EDITMSG", line: lineOf(body, re), msg: `AI/tool attribution: ${re.exec(body)![0].trim().slice(0, 60)}` }));
  const re = o.toml.glossary.commit_msg ? termRegex(avoidTerms(o)) : null;
  const words = re ? body.split("\n").map((t, i) => termFinding(re, { file: "COMMIT_EDITMSG", line: i + 1, text: t })) : [];
  return [...attr, ...words.filter((x): x is Finding => x !== null)];
}

const lineOf = (body: string, re: RegExp) => body.slice(0, re.exec(body)!.index).split("\n").length;
