// ast-grep structural rules on changed files, plus optional non-blocking Semgrep security notes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Opts } from "./config.ts";
import { type Changes, isTouched } from "./diff.ts";
import { adapterForFile, type LanguageAdapter, type LanguageId } from "./lang.ts";
import { installHint, npmSpec, pinnedVersion, toolBinary } from "./tools.ts";
import { check, type Finding, notedCheck, run } from "./util.ts";

const SG_CONFIG = join(import.meta.dir, "../../rules/sgconfig.yml");
const SEMGREP_CONFIG = join(import.meta.dir, "../../rules/semgrep.yml");
const SKIP = /(^|\/)(node_modules|fixtures|\.scratch|dist|build|target|\.venv)\//;
const SUPPRESSION = /((?:\/\/|#|\/\*|\*)[ \t]*)ast-grep-ignore\b/g;

type AstSpec = { language: string; root: string; catchKind?: string; empty: string; logs: string };

const BRACE_EMPTY = String.raw`\{\s*\}$`;
const BRACE_LOG = String.raw`\{\s*(?:(?:System\.(?:out|err)\.)?print(?:ln)?|Console\.WriteLine|debugPrint|error_log|(?:console|logger|log)(?:\.|->)\w+)\([^;]*\);?\s*\}$`;
const AST: Record<LanguageId, AstSpec> = {
  ts: { language: "TypeScript", root: "program", catchKind: "catch_clause", empty: BRACE_EMPTY, logs: BRACE_LOG },
  py: { language: "Python", root: "module", catchKind: "except_clause", empty: String.raw`:\s*(?:pass|\.\.\.)\s*$`, logs: String.raw`:\s*(?:print|logging\.\w+|logger\.\w+|log\.\w+)\([^\n]*\)\s*$` },
  go: { language: "Go", root: "source_file", empty: "", logs: "" },
  rust: { language: "Rust", root: "source_file", empty: "", logs: "" },
  java: { language: "Java", root: "program", catchKind: "catch_clause", empty: BRACE_EMPTY, logs: BRACE_LOG },
  kotlin: { language: "Kotlin", root: "source_file", catchKind: "catch_block", empty: BRACE_EMPTY, logs: BRACE_LOG },
  csharp: { language: "CSharp", root: "compilation_unit", catchKind: "catch_clause", empty: BRACE_EMPTY, logs: BRACE_LOG },
  swift: { language: "Swift", root: "source_file", catchKind: "catch_block", empty: BRACE_EMPTY, logs: BRACE_LOG },
  php: { language: "Php", root: "program", catchKind: "catch_clause", empty: BRACE_EMPTY, logs: BRACE_LOG },
  ruby: { language: "Ruby", root: "program", catchKind: "rescue", empty: String.raw`^rescue[^\n;]*(?:;|\n)?\s*$`, logs: String.raw`^rescue[\s\S]*?(?:puts|warn|logger\.\w+|log\.\w+)[^\n]*(?:;|\n)?\s*$` },
  cpp: { language: "Cpp", root: "translation_unit", catchKind: "catch_clause", empty: BRACE_EMPTY, logs: String.raw`\{\s*(?:(?:std::)?(?:printf|puts|fprintf|log\w*)\([^;]*\);|std::c(?:err|out)\s*<<[^;]+;)\s*\}$` },
  dart: { language: "Dart", root: "source_file", catchKind: "try_statement", empty: String.raw`catch\s*\([^)]*\)\s*\{\s*\}\s*$`, logs: String.raw`catch\s*\([^)]*\)\s*${BRACE_LOG}` },
};

const READ_API = String.raw`(?:readFileSync|ReadFile|read_to_string|readString|read_text|Files\.readString|File\.(?:read|readAsString)|IO\.read|file_get_contents)`;
const ASSERT_API = String.raw`(?:assert|expect|XCTAssert|Assert\.|self\.assert|\$this->assert|require\.|t\.(?:Fatal|Error))`;

function textRead(adapter: LanguageAdapter) {
  const extensions = adapter.extensions.map((ext) => ext.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `${READ_API}[^\\n]{0,400}\\.(?:${extensions})\\b(?:[^\\n]*\\n){0,4}[^\\n]*${ASSERT_API}`;
}

type AstRule = { id: string; kind: string; regex: string; message: string; files?: string[] };

function astRule(language: string, rule: AstRule) {
  return { id: rule.id, language, severity: "error", message: rule.message, files: rule.files, rule: { kind: rule.kind, regex: rule.regex } };
}

function rulesFor(adapter: LanguageAdapter) {
  const spec = AST[adapter.id];
  const rules = [astRule(spec.language, { id: "textual-test", kind: spec.root, regex: textRead(adapter), message: "test asserts on project file text; assert on behaviour instead", files: adapter.testGlobs })];
  if (!spec.catchKind) return rules;
  rules.unshift(astRule(spec.language, { id: "empty-catch", kind: spec.catchKind, regex: spec.empty, message: "empty catch swallows the error" }));
  rules.splice(1, 0, astRule(spec.language, { id: "catch-only-logs", kind: spec.catchKind, regex: spec.logs, message: "catch only logs and continues" }));
  return rules;
}

function inlineRules(adapter: LanguageAdapter) {
  return rulesFor(adapter).map((rule) => JSON.stringify(rule)).join("\n---\n");
}

// System ast-grep when it is the pinned version, else the pinned npm package.
function sgCommand(o: Opts): [string, string[]] {
  const spec = npmSpec("ast-grep", o.toml.tools);
  const binary = toolBinary("ast-grep", o.toml.tools);
  const version = run(binary, ["--version"], o.repo);
  if (version.code === 0 && version.out.includes(pinnedVersion(spec))) return [binary, []];
  return ["npx", ["-y", "-p", spec, "ast-grep"]];
}

function findingOf(match: any, ch: Changes, repo: string, aliases: Map<string, string>): Finding | null {
  const scanned = isAbsolute(match.file) ? relative(repo, match.file) : match.file.replace(/^\.\//, "");
  const file = aliases.get(scanned) ?? scanned;
  const line = match.range.start.line + 1;
  if (!isTouched(ch.get(file), line, match.range.end.line + 1)) return null;
  return { rule: `ast/${match.ruleId}`, file, line, msg: match.message };
}

function parseMatches(text: string) {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("ast-grep JSON is not an array");
  return value;
}

type AstContext = { o: Opts; ch: Changes; adapter: LanguageAdapter; files: string[]; command: [string, string[]] };

// ast-grep has inline `ast-grep-ignore` directives but no scan flag to disable them. Scan an
// ephemeral copy with only the directive word neutralized; preserve line and column positions.
function unsuppressedInput(o: Opts, files: string[]) {
  let shadow = "";
  const aliases = new Map<string, string>();
  const scanFiles = files.map((file) => {
    const source = readFileSync(join(o.repo, file), "utf8");
    const neutral = source.replace(SUPPRESSION, "$1ast-grep-xxxxxx");
    if (neutral === source) return file;
    if (!shadow) {
      mkdirSync(o.out, { recursive: true });
      shadow = mkdtempSync(join(o.out, "ast-scan-"));
    }
    const copy = join(shadow, file);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, neutral);
    const scanned = relative(o.repo, copy);
    aliases.set(scanned, file);
    return scanned;
  });
  return { scanFiles, aliases, cleanup: () => { if (shadow) rmSync(shadow, { recursive: true, force: true }); } };
}

function astGroup(context: AstContext) {
  const { o, ch, adapter, files, command } = context;
  const [cmd, pre] = command;
  const input = unsuppressedInput(o, files);
  try {
    const args = adapter.id === "ts" ? ["scan", "-c", SG_CONFIG, "--json=compact", ...input.scanFiles] : ["scan", "--inline-rules", inlineRules(adapter), "--json=compact", ...input.scanFiles];
    const result = run(cmd, [...pre, ...args], o.repo, { timeout: 300_000 });
    if (result.code === -1) return { findings: [] as Finding[], errors: [] as string[], notices: [`ast/${adapter.id}: not run (ast-grep not found; ${installHint("ast-grep", o.toml.tools)})`] };
    try {
      const findings = parseMatches(result.out).map((match) => findingOf(match, ch, o.repo, input.aliases)).filter((item): item is Finding => item !== null);
      const notices = AST[adapter.id].catchKind ? [] : [`ast/empty-catch: not run (${adapter.name} has no catch construct)`];
      return { findings, errors: [] as string[], notices };
    } catch (error) {
      const detail = (result.err || (error as Error).message).trim().slice(0, 300);
      return { findings: [] as Finding[], errors: [`${adapter.name}: ast-grep failed (exit ${result.code}): ${detail}`], notices: [] as string[] };
    }
  } finally {
    input.cleanup();
  }
}

export function astCheck(o: Opts, ch: Changes) {
  const todo = [...ch.keys()].filter((file) => adapterForFile(o.langs, file) && !SKIP.test(file) && existsSync(join(o.repo, file)));
  if (!todo.length) return check("ast", []);
  const command = sgCommand(o);
  const groups = Map.groupBy(todo, (file) => adapterForFile(o.langs, file)!);
  const results = [...groups].map(([adapter, files]) => astGroup({ o, ch, adapter, files, command }));
  return { name: "ast", findings: results.flatMap((item) => item.findings), error: results.flatMap((item) => item.errors).join("; "), note: "", notices: results.flatMap((item) => item.notices) };
}

export type SemgrepDeps = { run: typeof run };
const REAL_SEMGREP: SemgrepDeps = { run };

export function semgrepCheck(o: Opts, ch: Changes, deps: SemgrepDeps = REAL_SEMGREP) {
  const files = [...ch.keys()].filter((file) => adapterForFile(o.langs, file) && !SKIP.test(file) && existsSync(join(o.repo, file)));
  if (!files.length) return check("security/semgrep", []);
  const semgrep = toolBinary("semgrep", o.toml.tools);
  const version = deps.run(semgrep, ["--version"], o.repo);
  if (version.code === -1) return notedCheck("security/semgrep", [], "", [`security/semgrep: not run (semgrep not found; ${installHint("semgrep", o.toml.tools)})`]);
  const result = deps.run(semgrep, ["--config", SEMGREP_CONFIG, "--json", "--quiet", ...files], o.repo, { timeout: 300_000 });
  return semgrepResult(result);
}

function semgrepResult(result: ReturnType<typeof run>) {
  try {
    const rows: any[] = JSON.parse(result.out).results ?? [];
    const notices = rows.map((row) => `note: security/semgrep ${row.check_id} ${row.path}:${row.start?.line ?? 0} ${row.extra?.message ?? "security match"}`);
    return notedCheck("security/semgrep", [], `${notices.length} note(s), non-blocking`, notices);
  } catch (error) {
    const detail = (result.err || (error as Error).message).trim().slice(0, 240);
    return notedCheck("security/semgrep", [], "", [`security/semgrep: not run (semgrep failed: ${detail})`]);
  }
}
