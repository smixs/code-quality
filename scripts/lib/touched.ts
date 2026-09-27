// Touched tests of a change: by name for every adapter, by import for TS. pre-push and check --tests
// select with it; source changed and no test selected is tamper/no-tests-ran unless qg:no-test.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import type { Opts } from "./config.ts";
import { adapterForFile, isTestFile, siblingTestFiles } from "./lang.ts";
import { isProjectSource } from "./tamper.ts";
import { bypassNote, check, gitPaths, lines, notedCheck } from "./util.ts";

export function touchedTests(o: Opts, files: string[]) {
  return touchedTestSelection(o, files).tests;
}

// Pre-push: its cap, <stem>.test names and direct imports. check --tests and mutant: every test; depth 2
// also counts a test that reaches the source through one intermediate repo file (test -> harness or
// module -> source); stemNames counts <stem>.<anything>.test.<ext> beside the source; pathLiterals
// counts a quoted path in a test that names a tracked file. A source three steps away (test -> harness
// -> screen -> component) stays unselected; the project's full run covers it.
export type SelectionOptions = { maxTests: number; depth: 1 | 2; stemNames: boolean; pathLiterals: boolean };
export const ACCEPTANCE: SelectionOptions = { maxTests: Infinity, depth: 2, stemNames: true, pathLiterals: true };
const prePushSelection = (o: Opts): SelectionOptions => ({ maxTests: Number(o.toml.hooks.pre_push_max_tests), depth: 1, stemNames: false, pathLiterals: false });

export function touchedTestSelection(o: Opts, files: string[], options: SelectionOptions = prePushSelection(o)) {
  const named = existingNamedTests(o, files, options.stemNames);
  const imports = importingTests(o, files, options);
  const direct = imports.direct.filter((file) => !named.includes(file));
  const hop = imports.secondHop.filter((file) => !named.includes(file) && !direct.includes(file));
  const max = Math.max(0, Math.floor(options.maxTests));
  const byName = named.slice(0, max);
  const byImport = direct.slice(0, Math.max(0, max - byName.length));
  const bySecondHop = hop.slice(0, Math.max(0, max - byName.length - byImport.length));
  const omitted = named.length + direct.length + hop.length - byName.length - byImport.length - bySecondHop.length;
  return { tests: [...byName, ...byImport, ...bySecondHop], byName: byName.length, byImport: byImport.length, bySecondHop: bySecondHop.length, omitted, max };
}

function existingNamedTests(o: Opts, files: string[], stemNames: boolean) {
  const candidates = files.flatMap((file) => (isTestFile(o.langs, file) ? [file] : [...siblingTestFiles(o.langs, file), ...(stemNames ? stemTests(o, file) : [])]));
  return [...new Set(candidates)].filter((file) => existsSync(join(o.repo, file))).sort();
}

// Test files in the source's folder named <stem>.<anything>: ThemePanel.render.test.ts for ThemePanel.tsx.
function stemTests(o: Opts, file: string) {
  const dir = dirname(file);
  const name = basename(file);
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  if (!existsSync(join(o.repo, dir))) return [];
  return readdirSync(join(o.repo, dir)).filter((entry) => entry.startsWith(`${stem}.`)).map((entry) => (dir === "." ? entry : `${dir}/${entry}`)).filter((test) => isTestFile(o.langs, test));
}

function importingTests(o: Opts, files: string[], options: SelectionOptions) {
  const sources = files.filter((file) => isProjectSource(o, file) && adapterForFile(o.langs, file)?.id === "ts");
  if (!sources.length) return { direct: [], secondHop: [] };
  const aliases = tsAliases(o.repo);
  const tracked = lines(gitPaths(o.repo, "ls-files"));
  const tsFiles = tracked.filter((file) => adapterForFile(o.langs, file)?.id === "ts").sort();
  const tests = tsFiles.filter((file) => isTestFile(o.langs, file));
  const testRules: ImportRules = { reexports: true, literals: options.pathLiterals ? new Set(tracked) : null };
  const direct = tests.filter((test) => fileImports(o.repo, test, sources, aliases, testRules));
  if (options.depth < 2) return { direct, secondHop: [] };
  // Intermediates: repo TS files outside node_modules that import the source; a re-export is no import.
  const middles = tsFiles.filter((file) => !sources.includes(file) && !/(^|\/)node_modules\//.test(file) && fileImports(o.repo, file, sources, aliases, { reexports: false, literals: null }));
  const secondHop = tests.filter((test) => !direct.includes(test) && fileImports(o.repo, test, middles.filter((file) => file !== test), aliases, testRules));
  return { direct, secondHop };
}

type Alias = { pattern: string; target: string };

const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'`][^"'`]+["'`]/g;

// reexports: export ... from counts as an import; literals: the tracked files a quoted path may name
// (tests only), null = strings are not imports.
type ImportRules = { reexports: boolean; literals: Set<string> | null };

function fileImports(repo: string, test: string, sources: string[], aliases: Alias[], rules: ImportRules = { reexports: true, literals: null }) {
  const path = join(repo, test);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  if (rules.literals && pathLiterals(repo, test, text, rules.literals).some((file) => sources.includes(file))) return true;
  const modules = [...(rules.reexports ? text : text.replace(REEXPORT, "")).matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  return modules.some((module) => sources.some((source) => importTargets(test, module, source, aliases)));
}

// A quoted string in a test that resolves from the test's folder to an existing tracked file:
// runHarness(resolve(import.meta.dir, "ThemePanel.render-harness.tsx")).
function pathLiterals(repo: string, test: string, text: string, tracked: Set<string>) {
  const strings = [...text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`$\n]+)`/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  return strings.map((value) => normalize(join(dirname(test), value))).filter((file) => tracked.has(file) && existsSync(join(repo, file)));
}

function importTargets(test: string, module: string, source: string, aliases: Alias[]) {
  if (module.startsWith(".")) return sameModule(source, normalize(join(dirname(test), module)));
  return aliases.some((alias) => sameModule(source, expandAlias(alias, module)));
}

function sameModule(source: string, target: string) {
  if (!target) return false;
  const from = stripModuleExt(normalize(source));
  const to = stripModuleExt(normalize(target));
  return from === to || from === `${to}/index`;
}

const stripModuleExt = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "");

function expandAlias(alias: Alias, module: string) {
  const star = alias.pattern.indexOf("*");
  if (star < 0) return alias.pattern === module ? alias.target : "";
  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!module.startsWith(prefix) || !module.endsWith(suffix)) return "";
  return alias.target.replace("*", module.slice(prefix.length, module.length - suffix.length));
}

function tsAliases(repo: string): Alias[] {
  const path = join(repo, "tsconfig.json");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const body = /["']paths["']\s*:\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const base = /["']baseUrl["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? ".";
  return [...body.matchAll(/["']([^"']+)["']\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[2].matchAll(/["']([^"']+)["']/g)].map((target) => ({ pattern: match[1], target: normalize(join(base, target[1])) })));
}

// messages = the commit messages of the change; the first qg:no-test <reason> in them is the bypass.
export function noTestCheck(sourceChanged: boolean, tests: number, messages: string) {
  if (!sourceChanged || tests) return check("tamper/no-tests-ran", []);
  const reason = noTestReason(messages);
  if (reason) return notedCheck("tamper/no-tests-ran", [], "", [bypassNote("tamper/no-tests-ran", "commit-msg", reason)]);
  return check("tamper/no-tests-ran", [{ rule: "tamper/no-tests-ran", file: ".", line: 0, msg: "source changed, no test touched or found; add/refer a test or qg:no-test <reason>" }]);
}

const noTestReason = (text: string) => /(?:^|\s)qg:no-test\s+(\S.*)$/m.exec(text)?.[1].trim() ?? "";

