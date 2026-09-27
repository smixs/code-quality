// Touched tests of a change: by name for every adapter, by import for TS. pre-push and check --tests
// select with it; source changed and no test selected is tamper/no-tests-ran unless qg:no-test.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Opts } from "./config.ts";
import { adapterForFile, isTestFile, siblingTestFiles } from "./lang.ts";
import { isProjectSource } from "./tamper.ts";
import { bypassNote, check, gitPaths, lines, notedCheck } from "./util.ts";

export function touchedTests(o: Opts, files: string[]) {
  return touchedTestSelection(o, files).tests;
}

// Pre-push: its cap and direct imports. check --tests and mutant: every test, and depth 2 also counts a
// test that reaches the source through one intermediate repo file (test -> harness or module -> source).
export type SelectionOptions = { maxTests: number; depth: 1 | 2 };
export const ACCEPTANCE: SelectionOptions = { maxTests: Infinity, depth: 2 };
const prePushSelection = (o: Opts): SelectionOptions => ({ maxTests: Number(o.toml.hooks.pre_push_max_tests), depth: 1 });

export function touchedTestSelection(o: Opts, files: string[], options: SelectionOptions = prePushSelection(o)) {
  const named = existingNamedTests(o, files);
  const imports = importingTests(o, files, options.depth);
  const direct = imports.direct.filter((file) => !named.includes(file));
  const hop = imports.secondHop.filter((file) => !named.includes(file) && !direct.includes(file));
  const max = Math.max(0, Math.floor(options.maxTests));
  const byName = named.slice(0, max);
  const byImport = direct.slice(0, Math.max(0, max - byName.length));
  const bySecondHop = hop.slice(0, Math.max(0, max - byName.length - byImport.length));
  const omitted = named.length + direct.length + hop.length - byName.length - byImport.length - bySecondHop.length;
  return { tests: [...byName, ...byImport, ...bySecondHop], byName: byName.length, byImport: byImport.length, bySecondHop: bySecondHop.length, omitted, max };
}

function existingNamedTests(o: Opts, files: string[]) {
  const candidates = files.flatMap((file) => (isTestFile(o.langs, file) ? [file] : siblingTestFiles(o.langs, file)));
  return [...new Set(candidates)].filter((file) => existsSync(join(o.repo, file))).sort();
}

function importingTests(o: Opts, files: string[], depth: 1 | 2) {
  const sources = files.filter((file) => isProjectSource(o, file) && adapterForFile(o.langs, file)?.id === "ts");
  if (!sources.length) return { direct: [], secondHop: [] };
  const aliases = tsAliases(o.repo);
  const tsFiles = lines(gitPaths(o.repo, "ls-files")).filter((file) => adapterForFile(o.langs, file)?.id === "ts").sort();
  const tests = tsFiles.filter((file) => isTestFile(o.langs, file));
  const direct = tests.filter((test) => fileImports(o.repo, test, sources, aliases));
  if (depth < 2) return { direct, secondHop: [] };
  const middles = tsFiles.filter((file) => !sources.includes(file) && fileImports(o.repo, file, sources, aliases));
  const secondHop = tests.filter((test) => !direct.includes(test) && fileImports(o.repo, test, middles.filter((file) => file !== test), aliases));
  return { direct, secondHop };
}

type Alias = { pattern: string; target: string };

function fileImports(repo: string, test: string, sources: string[], aliases: Alias[]) {
  const path = join(repo, test);
  if (!existsSync(path)) return false;
  const modules = [...readFileSync(path, "utf8").matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  return modules.some((module) => sources.some((source) => importTargets(test, module, source, aliases)));
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

