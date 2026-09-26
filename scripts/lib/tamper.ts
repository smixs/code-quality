// Deterministic checks for "green" changes that weaken the evidence instead of improving code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Opts } from "./config.ts";
import type { Changes, DiffHunk } from "./diff.ts";
import { adapterById, adapterForFile, isTestFile, matchesTestPattern, type LanguageAdapter } from "./lang.ts";
import { bypassNote, type BypassSource, type Finding, notedCheck, run } from "./util.ts";

const CALL_WEAKENINGS = [
  {
    strong: /\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual)\s*\(/,
    weak: /\bassert(?:\.ok)?\s*\(/,
  },
  {
    strong: /\bexpect\s*\([\s\S]*?\)\s*\.(?:toEqual|toBe|toStrictEqual|toMatchObject)\s*\(/,
    weak: /\bexpect\s*\([\s\S]*?\)\s*\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined)\s*\(/,
  },
  {
    strong: /\b(?:\w+\.)?(?:assertEqual|assertDictEqual|assertListEqual)\s*\(/,
    weak: /\b(?:\w+\.)?(?:assertTrue|assertIsNotNone)\s*\(/,
  },
];
const TAMPER_MARK = /(?:qg:(?:allow|test-removed)|gitleaks:allow)\b/;
const DOCUMENTED_MARK = /`(?:qg:(?:allow|test-removed)|gitleaks:allow)\b[^`]*`/;
const MARK_ONLY = /^\s*(?:(?:\/\/|#|<!--)\s*)?(?:qg:(?:allow|test-removed)|gitleaks:allow)\b.*?(?:-->)?\s*$/;
const ESLINT_GATE_RULES = new Set(["complexity", "sonarjs/cognitive-complexity", "max-depth", "max-params", "max-lines-per-function"]);
const AST_GATE_RULES = new Set(["empty-catch", "catch-only-logs", "textual-test"]);

const MOCKS = [
  /\b(?:vi|jest)\.mock\s*\(\s*["'`]([^"'`]+)["'`]/,
  /\bmock\.module\s*\(\s*["'`]([^"'`]+)["'`]/,
  /\bmonkeypatch\.setattr\s*\(\s*["'`]([^"'`]+)["'`]/,
  /@patch\s*\(\s*["'`]([^"'`]+)["'`]/,
  /\bmocker\.patch\s*\(\s*["'`]([^"'`]+)["'`]/,
];

export function isProjectSource(o: Opts, file: string) {
  return Boolean(adapterForFile(o.langs, file)) && !isTestFile(o.langs, file) && inProjectDirs(o.dirs, file);
}

function isSourceForDirs(lang: string, dirs: string[], file: string) {
  const adapter = adapterById(lang);
  if (!adapter || !adapter.extensions.some((ext) => file.endsWith(ext))) return false;
  return !isTestFile([{ adapter, root: "." }], file) && inProjectDirs(dirs, file);
}

function inProjectDirs(dirs: string[], file: string) {
  return dirs.some((raw) => {
    const dir = normalize(raw).replace(/^\.\/$/, ".").replace(/\/$/, "");
    return dir === "." || file === dir || file.startsWith(`${dir}/`);
  });
}

export type TamperContext = { allowFile?: boolean; commitMessages?: string; configBefore?: string; configAfter?: string };
type AcceptedBypass = { source: BypassSource; reason: string };

export function tamperCheck(o: Opts, ch: Changes, context: TamperContext = {}) {
  const removed = testDeleted(ch, o);
  const weakened = assertionWeakened(o, ch);
  const bypass = removalBypass(o, context);
  const findings = [...(bypass ? [] : removed), ...testSkipped(o, ch), ...weakened, ...inlineSuppressions(o, ch)];
  const bypasses = bypass ? removalBypassNotes(bypass, removed) : [];
  const baseline = baselineTouched(o, ch, context);
  return notedCheck("tamper", [...findings, ...baseline.findings], "", [...bypasses, ...mockNotes(o, ch), ...baseline.notes]);
}

type Comment = { line: number; text: string };
type CommentScan = { index: number; line: number; quote: string; comments: Comment[] };

// Read comments from the current source, so a directive-shaped string does not become a finding.
function sourceComments(source: string, hashComments: boolean): Comment[] {
  const scan: CommentScan = { index: 0, line: 1, quote: "", comments: [] };
  while (scan.index < source.length) {
    if (skipQuoted(source, scan)) continue;
    if (openQuote(source, hashComments, scan)) continue;
    if (takeLineComment(source, hashComments, scan)) continue;
    if (takeBlockComment(source, scan)) continue;
    if (source[scan.index] === "\n") scan.line++;
    scan.index++;
  }
  return scan.comments;
}

function skipQuoted(source: string, scan: CommentScan) {
  if (!scan.quote) return false;
  if (source[scan.index] === "\\") {
    if (source[scan.index + 1] === "\n") scan.line++;
    scan.index += 2;
  } else if (source.startsWith(scan.quote, scan.index)) {
    scan.index += scan.quote.length;
    scan.quote = "";
  } else {
    if (source[scan.index] === "\n") scan.line++;
    scan.index++;
  }
  return true;
}

function openQuote(source: string, hashComments: boolean, scan: CommentScan) {
  const char = source[scan.index];
  if (char !== "'" && char !== '"' && char !== "`") return false;
  scan.quote = hashComments && source.startsWith(char.repeat(3), scan.index) ? char.repeat(3) : char;
  scan.index += scan.quote.length;
  return true;
}

function takeLineComment(source: string, hashComments: boolean, scan: CommentScan) {
  const slash = source.startsWith("//", scan.index);
  if (!slash && !(hashComments && source[scan.index] === "#")) return false;
  const start = scan.index + (slash ? 2 : 1);
  const end = source.indexOf("\n", start);
  scan.comments.push({ line: scan.line, text: source.slice(start, end < 0 ? source.length : end) });
  scan.index = end < 0 ? source.length : end;
  return true;
}

function takeBlockComment(source: string, scan: CommentScan) {
  if (!source.startsWith("/*", scan.index)) return false;
  const end = source.indexOf("*/", scan.index + 2);
  const text = source.slice(scan.index + 2, end < 0 ? source.length : end);
  scan.comments.push({ line: scan.line, text });
  scan.line += (text.match(/\n/g) ?? []).length;
  scan.index = end < 0 ? source.length : end + 2;
  return true;
}

function commentHead(comment: Comment) {
  let line = comment.line;
  for (const part of comment.text.split("\n")) {
    const text = part.replace(/^[ \t]*(?:\*[ \t]*)?/, "").trim();
    if (text) return { line, text };
    line++;
  }
  return null;
}

function suppressionReason(language: string, text: string) {
  const ast = astSuppression(text);
  if (ast) return ast;
  if (language === "ts") return eslintSuppression(text);
  if (language === "py") return pythonSuppression(text);
  if (language === "go") return goSuppression(text);
  return "";
}

function astSuppression(text: string) {
  const ast = /^ast-grep-ignore\b(.*)/.exec(text);
  if (!ast) return "";
  const rest = ast[1].trim();
  if (!rest.startsWith(":")) return "ast-grep-ignore suppresses code-quality structural rules";
  const ids = rest.slice(1).split(/[\s,]+/);
  const rule = ids.find((id) => AST_GATE_RULES.has(id));
  return rule ? `ast-grep-ignore suppresses code-quality rule ${rule}` : "";
}

function eslintSuppression(text: string) {
  const eslint = /^eslint-disable(?:-next-line|-line)?\b(.*)/.exec(text);
  if (!eslint) return "";
  const list = eslint[1].split(/\s+--(?:\s|$)/)[0].trim();
  if (!list) return "eslint-disable suppresses all code-quality ESLint rules";
  const rule = list.split(/[\s,]+/).find((id) => ESLINT_GATE_RULES.has(id));
  return rule ? `eslint-disable suppresses code-quality rule ${rule}` : "";
}

function pythonSuppression(text: string) {
  return /^noqa\b/.test(text) || /^ruff:\s*(?:noqa|file-ignore|ignore)\b/.test(text)
    ? "Python suppression comment hides Ruff form diagnostics" : "";
}

function goSuppression(text: string) {
  if (/^gocyclo:ignore\b/.test(text)) return "gocyclo:ignore hides Go form diagnostics";
  const nolint = /^nolint\b(.*)/.exec(text);
  if (!nolint) return "";
  const rest = nolint[1].trim();
  if (!rest) return "nolint suppresses Go lint diagnostics";
  const rules = rest.startsWith(":") ? rest.slice(1).split(/[\s,]+/) : [];
  if (rules.includes("gocyclo")) return "nolint:gocyclo suppresses Go complexity diagnostics";
  return "";
}

function inlineSuppressions(o: Opts, ch: Changes): Finding[] {
  return [...ch].flatMap(([file, diff]) => {
    const adapter = adapterForFile(o.langs, file);
    if (!adapter || !existsSync(join(o.repo, file))) return [];
    const hash = adapter.id === "py" || adapter.id === "ruby" || adapter.id === "php";
    return sourceComments(readFileSync(join(o.repo, file), "utf8"), hash).flatMap((comment) => {
      const head = commentHead(comment);
      if (!head || !diff.added.has(head.line)) return [];
      const reason = suppressionReason(adapter.id, head.text);
      return reason ? [finding("tamper/inline-suppression", file, head.line, reason)] : [];
    });
  });
}

function removalBypass(o: Opts, context: TamperContext): AcceptedBypass | null {
  const commit = markerBypass(context.commitMessages ?? commitMessages(o), "qg:test-removed", "commit-msg");
  if (commit) return commit;
  const permitted = context.allowFile ?? allowFilePermitted(o);
  return permitted ? markerBypass(allowFile(o), "qg:test-removed", "allow.md") : null;
}

function markerBypass(text: string, marker: string, source: BypassSource): AcceptedBypass | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reason = new RegExp(`(?:^|\\s)${escaped}\\s+([^\\r\\n]+)`, "m").exec(text)?.[1].trim();
  return reason ? { source, reason } : null;
}

function removalBypassNotes(bypass: AcceptedBypass, removed: Finding[]) {
  const notes: string[] = [];
  if (removed.length) notes.push(bypassNote("tamper/test-deleted", bypass.source, bypass.reason));
  return notes;
}

// pre-commit (entry "hook") sees no commit message yet, so the staged reason lives in allow.md there too.
function allowFilePermitted(o: Opts) {
  return o.entry === "agent-stop" || ((o.entry === "check" || o.entry === "hook") && o.scope.kind === "staged");
}

function allowFile(o: Opts) {
  const path = join(o.repo, o.outDir, "allow.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function commitMessages(o: Opts) {
  if (o.scope.kind === "all" || o.scope.kind === "staged") return "";
  const from = o.scope.kind === "since" ? o.scope.rev : run("git", ["merge-base", o.base, "HEAD"], o.repo).out.trim();
  if (!from) return "";
  return run("git", ["log", "--format=%B", `${from}..HEAD`], o.repo).out;
}

function testDeleted(ch: Changes, o: Opts): Finding[] {
  return [...ch].filter(([file]) => isTestFile(o.langs, file)).flatMap(([file, d]) => {
    if (d.deleted) return [finding("tamper/test-deleted", file, 1, "test file deleted")];
    const adapter = adapterForFile(o.langs, file)!;
    return d.hunks.filter((hunk) => blockRemoved(adapter, hunk)).map((h) => finding("tamper/test-deleted", file, h.newStart, "test block deleted"));
  });
}

function blockRemoved(adapter: LanguageAdapter, h: DiffHunk) {
  const added = testHeaders(h.added, adapter);
  const removed = testHeaders(h.removed, adapter);
  consumeHeaders(removed, added, (before, after) => before === after);
  consumeHeaders(removed, added, renamedHeader);
  return removed.length > 0;
}

function testHeaders(lines: Map<number, string>, adapter: LanguageAdapter) {
  return [...lines.values()].map(activeTestHeader).filter((line) => matchesTestPattern(adapter, "test", line));
}

function activeTestHeader(line: string) {
  return line
    .replace(/\b(test|it|describe)\.(?:skip|todo|only)\s*\(/, "$1(")
    .replace(/\b(?:xit|fit)\s*\(/, "it(")
    .replace(/\bxdescribe\s*\(/, "describe(")
    .replace(/\bsolo_test\s*\(/, "test(")
    .trim().replace(/\s+/g, " ");
}

function consumeHeaders(removed: string[], added: string[], same: (before: string, after: string) => boolean) {
  for (let old = removed.length - 1; old >= 0; old--) {
    const replacement = added.findIndex((line) => same(removed[old], line));
    if (replacement < 0) continue;
    removed.splice(old, 1);
    added.splice(replacement, 1);
  }
}

function renamedHeader(before: string, after: string) {
  if (testCall(before) !== testCall(after)) return false;
  const oldWords = titleWords(before);
  const shared = titleWords(after).filter((word) => oldWords.includes(word));
  return shared.length >= 2 || shared.some((word) => word.length >= 7);
}

const testCall = (line: string) => /\b(test|it|describe)\s*\(/.exec(line)?.[1] ?? "";

function titleWords(line: string) {
  const title = /\(\s*["'`]([^"'`]+)["'`]/.exec(line)?.[1] ?? "";
  return (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 3)
    .map((word) => /^[a-z]+s$/.test(word) ? word.slice(0, -1) : word);
}

function testSkipped(o: Opts, ch: Changes): Finding[] {
  return testAdded(o, ch).filter((item) => skipMarker(o, item.file, item.text)).map((x) => finding("tamper/test-skipped", x.file, x.line, "test was skipped, focused, or marked todo/xfail"));
}

function skipMarker(o: Opts, file: string, text: string) {
  const adapter = adapterForFile(o.langs, file)!;
  return matchesTestPattern(adapter, "skip", text) || matchesTestPattern(adapter, "only", text);
}

function assertionWeakened(o: Opts, ch: Changes): Finding[] {
  const testChanges = [...ch].filter(([file]) => isTestFile(o.langs, file));
  const assertionsMoved = testChanges.reduce((sum, [file, d]) => {
    const adapter = adapterForFile(o.langs, file)!;
    return sum + countPattern(d.added, adapter, "assert") - countPattern(d.removed, adapter, "assert");
  }, 0) >= 0;
  // A deleted test file is one tamper/test-deleted finding (accepted by qg:test-removed); its
  // removed assertions are not a second, unbypassable "fewer assertions" finding at line 0.
  return testChanges.filter(([, d]) => !d.deleted).flatMap(([file, d]) => {
    const harnesses = sourceHarnesses(d.removed);
    return d.hunks.flatMap((h) => assertionFinding(o, file, h, assertionsMoved && sourceHarnessRemoval(o, file, h, harnesses)));
  });
}

function sourceHarnesses(lines: Map<number, string>) {
  const text = [...lines.values()].join("\n");
  return [...text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*readFileSync\s*\(/g)].map((match) => match[1]);
}

function sourceHarnessRemoval(o: Opts, file: string, h: DiffHunk, harnesses: string[]) {
  if (!harnesses.length || countPattern(h.added, adapterForFile(o.langs, file)!, "assert")) return false;
  const targets = callTargets(joined(h.removed), /\b(?:assert(?:\.\w+)?|expect)\s*\(/);
  const removed = countPattern(h.removed, adapterForFile(o.langs, file)!, "assert");
  return targets.length === removed && targets.every((target) => harnesses.some((name) => compact(target) === name));
}

function assertionFinding(o: Opts, file: string, h: DiffHunk, sourceHarnessMoved: boolean): Finding[] {
  const adapter = adapterForFile(o.langs, file)!;
  const fewer = !sourceHarnessMoved && countPattern(h.removed, adapter, "assert") > countPattern(h.added, adapter, "assert");
  const weaker = assertionReplacement(h);
  if (!fewer && !weaker) return [];
  const why = [fewer ? "fewer assertions in hunk" : "", weaker ? "strong assertion replaced with a weak assertion" : ""].filter(Boolean).join("; ");
  return [finding("tamper/assertion-weakened", file, h.newStart, why)];
}

function assertionReplacement(h: DiffHunk) {
  const removed = joined(h.removed);
  const added = joined(h.added);
  return CALL_WEAKENINGS.some((pair) => pairedCall(removed, added, pair.strong, pair.weak)) || bareAssertWeakened(h);
}

function joined(lines: Map<number, string>) {
  return [...lines].toSorted(([a], [b]) => a - b).map(([, line]) => line).join("\n");
}

function pairedCall(removed: string, added: string, strong: RegExp, weak: RegExp) {
  const oldTargets = callTargets(removed, strong);
  const newTargets = new Set(callTargets(added, weak));
  return oldTargets.some((target) => newTargets.has(target));
}

function callTargets(text: string, pattern: RegExp) {
  const re = new RegExp(pattern.source, "g");
  return [...text.matchAll(re)].map((match) => firstArgument(text, match.index)).filter(Boolean);
}

function firstArgument(text: string, start: number) {
  const open = text.indexOf("(", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && depth-- === 0) return compact(text.slice(open + 1, i));
    if (text[i] === "," && depth === 0) return compact(text.slice(open + 1, i));
  }
  return "";
}

function bareAssertWeakened(h: DiffHunk) {
  const oldTargets = [...h.removed.values()].map((line) => /^\s*assert\s+(.+?)\s*==/.exec(line)?.[1] ?? "").filter(Boolean).map(compact);
  const newTargets = new Set([...h.added.values()].map((line) => /^\s*assert\s+(.+?)\s*(?:#.*)?$/.exec(line)?.[1] ?? "").filter(Boolean).map(compact));
  return oldTargets.some((target) => newTargets.has(target));
}

const compact = (text: string) => text.replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1");

function countPattern(lines: Map<number, string>, adapter: LanguageAdapter, kind: "test" | "assert") {
  return [...lines.values()].filter((line) => matchesTestPattern(adapter, kind, line)).length;
}

function testAdded(o: Opts, ch: Changes) {
  return [...ch].filter(([file]) => isTestFile(o.langs, file)).flatMap(([file, d]) => [...d.added].map(([line, text]) => ({ file, line, text })));
}

function mockNotes(o: Opts, ch: Changes) {
  const sources = [...ch.keys()].filter((f) => isProjectSource(o, f));
  const modules = testAdded(o, ch).flatMap((x) => {
    const module = mockModule(x.text);
    if (!module) return genericMockNote(o, x);
    if (moduleChanged(o, x.file, module, sources)) return [];
    return [`note: tamper/mock-added ${x.file}:+${x.line} ${module}`];
  });
  const stubs = [...ch].filter(([file]) => isTestFile(o.langs, file)).flatMap(([file, d]) => localStubShadows(o, ch, file, [...d.added].map(([line, text]) => ({ line, text }))));
  return [...modules, ...stubs.map((x) => `note: tamper/mock-added ${x.testFile}:+${x.line} local stub shadows ${x.name} from ${x.source}`)];
}

function genericMockNote(o: Opts, item: { file: string; line: number; text: string }) {
  const adapter = adapterForFile(o.langs, item.file)!;
  return matchesTestPattern(adapter, "mock", item.text) ? [`note: tamper/mock-added ${item.file}:+${item.line} ${adapter.name} mock/stub`] : [];
}

type Added = { line: number; text: string };
type StubShadow = { testFile: string; line: number; name: string; source: string };

export function localStubShadows(o: Opts, ch: Changes, testFile: string, added: Added[]): StubShadow[] {
  const bindings = importedBindings(o, testFile);
  const exports = changedExports(o, ch);
  return added.flatMap(({ line, text }) => {
    const stub = localStubName(text);
    if (!stub) return [];
    const imported = bindings.find((item) => shadowsName(stub, item.name));
    const changed = exports.find((item) => shadowsName(stub, item.name));
    const hit = imported ?? changed;
    return hit ? [{ testFile, line, name: hit.name, source: hit.source }] : [];
  });
}

function localStubName(line: string) {
  return /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/.exec(line)?.[1]
    ?? /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line)?.[1]
    ?? "";
}

function shadowsName(stub: string, source: string) {
  if (stub === source) return true;
  return /^(?:re|mock|fake|stub)/i.test(stub) && stub.toLowerCase().endsWith(source.toLowerCase());
}

function importedBindings(o: Opts, testFile: string) {
  const path = join(o.repo, testFile);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return [...namedImports(text), ...dynamicImports(text)].flatMap(({ names, module }) => {
    const source = relativeSource(o, testFile, module);
    return source ? names.map((name) => ({ name, source })) : [];
  });
}

function namedImports(text: string) {
  return importMatches(text, /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'`]([^"'`]+)["'`]/g, "as");
}

function dynamicImports(text: string) {
  return importMatches(text, /(?:const|let)\s*\{([\s\S]*?)\}\s*=\s*await\s+import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, ":");
}

function importMatches(text: string, re: RegExp, alias: "as" | ":") {
  return [...text.matchAll(re)].map((match) => ({ module: match[2], names: match[1].split(",").map((part) => localImportName(part, alias)).filter(Boolean) }));
}

function localImportName(part: string, alias: "as" | ":") {
  const words = part.trim().replace(/^type\s+/, "").split(alias === "as" ? /\s+as\s+/ : /\s*:\s*/);
  return (words[1] ?? words[0]).trim();
}

function relativeSource(o: Opts, testFile: string, module: string) {
  if (!module.startsWith(".")) return "";
  const target = normalize(join(dirname(testFile), module));
  const candidates = [target, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].map((ext) => `${target}${ext}`), ...[".ts", ".tsx", ".js"].map((ext) => join(target, `index${ext}`))];
  return candidates.find((file) => existsSync(join(o.repo, file)) && isProjectSource(o, file)) ?? "";
}

function changedExports(o: Opts, ch: Changes) {
  return [...ch.keys()].filter((file) => isProjectSource(o, file)).flatMap((source) => {
    const path = join(o.repo, source);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const patterns = [
      /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /\bexport\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
    ];
    return [...new Set(patterns.flatMap((re) => [...text.matchAll(re)].map((match) => match[1])))].map((name) => ({ name, source }));
  });
}

function mockModule(line: string) {
  return MOCKS.map((re) => re.exec(line)?.[1] ?? "").find(Boolean) ?? "";
}

function moduleChanged(o: Opts, testFile: string, module: string, sources: string[]) {
  return o.lang === "py" ? sources.some((f) => pythonTarget(f, module)) : sources.some((f) => tsTarget(testFile, f, module));
}

function pythonTarget(file: string, module: string) {
  const dotted = file.replace(/\.py$/, "").replace(/\/__init__$/, "").replaceAll("/", ".");
  return module === dotted || module.startsWith(`${dotted}.`);
}

function tsTarget(testFile: string, file: string, module: string) {
  const target = module.startsWith(".") ? normalize(join(dirname(testFile), module)) : normalize(module);
  const source = stripTs(file);
  const wanted = stripTs(target);
  return source === wanted || source === `${wanted}/index`;
}

const stripTs = (file: string) => file.replace(/\.(?:[cm]?[jt]sx?)$/, "");

function baselineTouched(o: Opts, ch: Changes, context: TamperContext) {
  const config = configPair(o, context);
  const oldDirs = projectDirs(config.before);
  const sources = [...ch.keys()].filter((f) => isProjectSource(o, f) || isSourceForDirs(o.lang, oldDirs, f));
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const item of protectedChanges(ch, config, o.outDir)) {
    const block = item.kind === "marker" ? item.other : sources.length > 0;
    if (block) findings.push(finding("tamper/baseline-touched", item.file, item.line, item.msg));
    else notes.push(`note: tamper/baseline-touched ${item.file}:${item.line} ${item.msg}`);
  }
  return { findings, notes };
}

type Protected = { kind: "baseline" | "config" | "marker"; file: string; line: number; msg: string; other: boolean };
type ConfigPair = { before: string; after: string };

function protectedChanges(ch: Changes, config: ConfigPair, outDir: string): Protected[] {
  const out: Protected[] = [];
  const baselineFile = `${outDir}/baseline.json`;
  const baseline = ch.get(baselineFile);
  if (baseline) out.push({ kind: "baseline", file: baselineFile, line: 1, msg: "quality baseline changed", other: false });
  const quality = ch.get(".quality.toml");
  const configDiff = quality ? protectedConfigDiff(config.before, config.after) : [];
  if (quality && configDiff.length) out.push({ kind: "config", file: ".quality.toml", line: quality.hunks[0]?.newStart ?? 1, msg: `protected config changed: ${configDiff.join("; ")}`, other: false });
  return [...out, ...markerChanges(ch)];
}

function markerChanges(ch: Changes): Protected[] {
  return [...ch].filter(([file]) => !file.startsWith(".scratch/")).flatMap(([file, diff]) => [...diff.added].flatMap(([line, text]) => {
    if (!TAMPER_MARK.test(text) || DOCUMENTED_MARK.test(text)) return [];
    const other = diff.added.size + diff.removed.size > 1 || !MARK_ONLY.test(text);
    return [{ kind: "marker", file, line, msg: "allow marker added with other changes", other } satisfies Protected];
  }));
}

const PROTECTED_CONFIG: Record<string, string[] | "*"> = {
  project: ["src"], thresholds: "*", security: "*",
  hooks: ["pre_push_test_cmd", "pre_push_max_tests", "pre_push_timeout"],
  secrets: ["allow_users"], review: "*", knip: ["ignore"], layers: "*",
  docs: ["globs", "history_globs"], glossary: ["allow"],
};

function protectedConfigDiff(beforeText: string, afterText: string) {
  const before = parseConfig(beforeText);
  const after = parseConfig(afterText);
  return Object.entries(PROTECTED_CONFIG).flatMap(([section, picked]) => changedConfigKeys(section, picked, before, after));
}

function changedConfigKeys(section: string, picked: string[] | "*", before: Record<string, any>, after: Record<string, any>) {
  const old = before[section] ?? {};
  const next = after[section] ?? {};
  const keys = picked === "*" ? [...new Set([...Object.keys(old), ...Object.keys(next)])].sort() : picked;
  return keys.filter((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key])).map((key) => `${section}.${key} ${configValue(old[key])} -> ${configValue(next[key])}`);
}

const configValue = (value: unknown) => value === undefined ? "<unset>" : JSON.stringify(value);

function parseConfig(text: string): Record<string, any> {
  try {
    return text.trim() ? Bun.TOML.parse(text) as Record<string, any> : {};
  } catch {
    return {};
  }
}

function projectDirs(text: string) {
  const dirs = parseConfig(text).project?.src;
  return Array.isArray(dirs) ? dirs.map(String) : [];
}

function configPair(o: Opts, context: TamperContext): ConfigPair {
  const supplied = suppliedConfig(context);
  if (supplied) return supplied;
  const fixed = fixedScopeConfig(o);
  if (fixed) return fixed;
  const base = run("git", ["merge-base", o.base, "HEAD"], o.repo).out.trim();
  const path = join(o.repo, ".quality.toml");
  return { before: showConfig(o, base), after: existsSync(path) ? readFileSync(path, "utf8") : "" };
}

function suppliedConfig(context: TamperContext) {
  if (context.configBefore === undefined && context.configAfter === undefined) return null;
  return { before: context.configBefore ?? "", after: context.configAfter ?? "" };
}

function fixedScopeConfig(o: Opts) {
  if (o.scope.kind === "all") return { before: "", after: "" };
  if (o.scope.kind === "staged") return { before: showConfig(o, "HEAD"), after: showConfig(o, ":") };
  if (o.scope.kind === "since") return { before: showConfig(o, o.scope.rev), after: showConfig(o, "HEAD") };
  return null;
}

function showConfig(o: Opts, ref: string) {
  const spec = ref === ":" ? ":.quality.toml" : `${ref}:.quality.toml`;
  const result = run("git", ["show", spec], o.repo);
  return result.code === 0 ? result.out : "";
}

const finding = (rule: string, file: string, line: number, msg: string): Finding => ({ rule, file, line, msg });
