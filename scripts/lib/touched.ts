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

// Pre-push: its cap, <stem>.test names and direct imports (root tsconfig paths). check --tests and
// mutant (closure): every test, <stem>.<anything>.test.<ext> beside the source counts as named, and a
// test that reaches the source through any chain of imports, re-exports, dynamic imports, require and
// test path literals is selected; modules resolve as the project resolves them (resolveModule).
export type SelectionOptions = { maxTests: number; closure: boolean };
export const ACCEPTANCE: SelectionOptions = { maxTests: Infinity, closure: true };
const prePushSelection = (o: Opts): SelectionOptions => ({ maxTests: Number(o.toml.hooks.pre_push_max_tests), closure: false });

export function touchedTestSelection(o: Opts, files: string[], options: SelectionOptions = prePushSelection(o)) {
  const named = existingNamedTests(o, files, options.closure);
  const sources = files.filter((file) => isProjectSource(o, file) && adapterForFile(o.langs, file)?.id === "ts");
  const imports = options.closure ? reachingTests(o, sources) : { direct: directTests(o, sources), further: [] };
  const direct = imports.direct.filter((file) => !named.includes(file));
  const reached = imports.further.filter((file) => !named.includes(file) && !direct.includes(file));
  const max = Math.max(0, Math.floor(options.maxTests));
  const byName = named.slice(0, max);
  const byImport = direct.slice(0, Math.max(0, max - byName.length));
  const further = reached.slice(0, Math.max(0, max - byName.length - byImport.length));
  const omitted = named.length + direct.length + reached.length - byName.length - byImport.length - further.length;
  return { tests: [...byName, ...byImport, ...further], byName: byName.length, byImport: byImport.length, further: further.length, omitted, max };
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

const MODULE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*(?:\(\s*)?)["'`]([^"'`]+)["'`]/g;
const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// pre-push: tests that import a source directly, aliases from the root tsconfig.json only.
function directTests(o: Opts, sources: string[]) {
  if (!sources.length) return [];
  const aliases = declaredAliases(o.repo, "tsconfig.json") ?? [];
  const tests = lines(gitPaths(o.repo, "ls-files")).filter((file) => adapterForFile(o.langs, file)?.id === "ts" && isTestFile(o.langs, file)).sort();
  return tests.filter((test) => [...readText(join(o.repo, test)).matchAll(MODULE)].some((m) => sources.some((source) => importTargets(test, m[1], source, aliases))));
}

// The closure: one reverse graph of the repo's TS files (outside node_modules), walked from the sources.
function reachingTests(o: Opts, sources: string[]) {
  if (!sources.length) return { direct: [], further: [] };
  const tracked = lines(gitPaths(o.repo, "ls-files"));
  const trackedSet = new Set(tracked);
  const nodes = tracked.filter((file) => adapterForFile(o.langs, file)?.id === "ts" && !/(^|\/)node_modules\//.test(file) && existsSync(join(o.repo, file))).sort();
  const resolve = moduleResolver(o.repo, tracked, nodes);
  const importers = new Map<string, Set<string>>();
  for (const file of nodes) {
    const text = readFileSync(join(o.repo, file), "utf8");
    const specs = [...text.matchAll(MODULE)].flatMap((m) => resolve(file, m[1]));
    const literals = isTestFile(o.langs, file) ? pathLiterals(o.repo, file, text, trackedSet) : [];
    for (const target of [...specs, ...literals]) importers.set(target, (importers.get(target) ?? new Set()).add(file));
  }
  const direct = nodes.filter((file) => isTestFile(o.langs, file) && sources.some((source) => importers.get(source)?.has(file)));
  const seen = new Set(sources);
  for (const queue = [...sources]; queue.length; ) {
    for (const file of importers.get(queue.pop()!) ?? []) {
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(file);
    }
  }
  const further = [...seen].filter((file) => isTestFile(o.langs, file) && !direct.includes(file)).sort();
  return { direct, further };
}

// A quoted string in a test that resolves from the test's folder to an existing tracked file:
// runHarness(resolve(import.meta.dir, "ThemePanel.render-harness.tsx")).
function pathLiterals(repo: string, test: string, text: string, tracked: Set<string>) {
  const strings = [...text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`$\n]+)`/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  return strings.map((value) => normalize(join(dirname(test), value))).filter((file) => tracked.has(file) && existsSync(join(repo, file)));
}

type Alias = { pattern: string; target: string };
type Package = { name: string; dir: string; entry: string };

// A module specifier -> the repo files it names: a relative path; `#…` through the imports of the nearest
// package.json at or above the file's folder; the paths of the nearest tsconfig.json (through relative
// extends); a workspace package by name or name/sub. A key decides as in TypeScript and Node (aliasTargets).
// Extensions and /index as for a relative import; anything else is external.
function moduleResolver(repo: string, tracked: string[], nodes: string[]) {
  const byModule = new Map<string, string[]>();
  for (const file of nodes) byModule.set(stripModuleExt(file), [...(byModule.get(stripModuleExt(file)) ?? []), file]);
  const lookup = (path: string) => (path ? [...(byModule.get(stripModuleExt(normalize(path))) ?? []), ...(byModule.get(`${stripModuleExt(normalize(path))}/index`) ?? [])] : []);
  const firstHit = (targets: string[]) => targets.map(lookup).find((hit) => hit.length) ?? [];
  const trackedSet = new Set(tracked);
  // The aliases of the nearest `name` at or above a folder, read once per folder.
  const nearest = (name: string, read: (file: string) => Alias[]) => {
    const byDir = new Map<string, Alias[]>();
    const walk = (dir: string): Alias[] => {
      if (!byDir.has(dir)) {
        const file = dir === "." ? name : `${dir}/${name}`;
        byDir.set(dir, trackedSet.has(file) ? read(file) : dir === "." ? [] : walk(dirname(dir)));
      }
      return byDir.get(dir)!;
    };
    return walk;
  };
  const aliasesFor = nearest("tsconfig.json", (file) => inheritedAliases(repo, file));
  const importsFor = nearest("package.json", (file) => packageImports(repo, file));
  const packages = workspacePackages(repo, tracked);
  return (from: string, spec: string): string[] => {
    if (spec.startsWith(".")) return lookup(join(dirname(from), spec));
    if (spec.startsWith("#")) return firstHit(aliasTargets(importsFor(dirname(from)), spec));
    const hit = firstHit(aliasTargets(aliasesFor(dirname(from)), spec));
    if (hit.length) return hit;
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return [];
    if (spec === pkg.name) return lookup(join(pkg.dir, pkg.entry));
    const sub = spec.slice(pkg.name.length + 1);
    return firstHit([join(pkg.dir, sub), join(pkg.dir, "src", sub)]);
  };
}

// The key that decides a specifier: an exact key, else the `*` pattern with the longest prefix before
// `*`; only that key's targets, in their order. Declaration order does not decide.
function aliasTargets(aliases: Alias[], spec: string) {
  const exact = aliases.filter((alias) => alias.pattern === spec);
  if (exact.length) return exact.map((alias) => alias.target);
  const matching = aliases.filter((alias) => alias.pattern.includes("*") && expandAlias(alias, spec));
  const longest = Math.max(-1, ...matching.map((alias) => alias.pattern.indexOf("*")));
  const key = matching.find((alias) => alias.pattern.indexOf("*") === longest)?.pattern;
  return matching.filter((alias) => alias.pattern === key).map((alias) => expandAlias(alias, spec));
}

// package.json#imports: "#key": a string, or the import / default of a condition object; targets from
// that package.json's folder.
function packageImports(repo: string, file: string): Alias[] {
  const imports = parseJson(readText(join(repo, file)))?.imports;
  if (!imports || typeof imports !== "object") return [];
  return Object.entries(imports as Record<string, unknown>).flatMap(([pattern, value]) => {
    const target = typeof value === "string" ? value : ((value as Conditions | null)?.import ?? (value as Conditions | null)?.default);
    return typeof target === "string" ? [{ pattern, target: normalize(join(dirname(file), target)) }] : [];
  });
}

type Conditions = { import?: unknown; default?: unknown };

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The paths a tsconfig declares, else the ones its relative extends chain declares.
function inheritedAliases(repo: string, config: string): Alias[] {
  const seen = new Set<string>();
  for (let file = config; file && !file.startsWith("..") && !seen.has(file); ) {
    seen.add(file);
    const own = declaredAliases(repo, file);
    if (own) return own;
    const parent = /["']extends["']\s*:\s*["'](\.[^"']+)["']/.exec(readText(join(repo, file)))?.[1];
    file = parent ? normalize(join(dirname(file), parent.endsWith(".json") ? parent : `${parent}.json`)) : "";
  }
  return [];
}

// null = the config declares no paths. Targets resolve against its baseUrl, else its own folder.
function declaredAliases(repo: string, config: string): Alias[] | null {
  const text = readText(join(repo, config));
  const body = /["']paths["']\s*:\s*\{([^}]*)\}/.exec(text)?.[1];
  if (body === undefined) return null;
  const base = join(dirname(config), /["']baseUrl["']\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? ".");
  return [...body.matchAll(/["']([^"']+)["']\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => [...match[2].matchAll(/["']([^"']+)["']/g)].map((target) => ({ pattern: match[1], target: normalize(join(base, target[1])) })));
}

// Tracked package.json files outside node_modules with a name; the bare name goes to exports as a string
// or exports["."] (a string, or its import / default), else module, else main, else src/index. Longest
// name first.
function workspacePackages(repo: string, tracked: string[]): Package[] {
  return tracked.filter((file) => basename(file) === "package.json" && !/(^|\/)node_modules\//.test(file)).flatMap((file) => {
    const pkg = parseJson(readText(join(repo, file)));
    if (typeof pkg?.name !== "string" || !pkg.name) return [];
    const dot = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
    const exported = typeof dot === "string" ? dot : (dot?.import ?? dot?.default);
    const entry = [exported, pkg.module, pkg.main].find((value) => typeof value === "string") ?? "src/index";
    return [{ name: pkg.name, dir: dirname(file), entry }];
  }).sort((a, b) => b.name.length - a.name.length);
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

// messages = the commit messages of the change; the first qg:no-test <reason> in them is the bypass.
export function noTestCheck(sourceChanged: boolean, tests: number, messages: string) {
  if (!sourceChanged || tests) return check("tamper/no-tests-ran", []);
  const reason = noTestReason(messages);
  if (reason) return notedCheck("tamper/no-tests-ran", [], "", [bypassNote("tamper/no-tests-ran", "commit-msg", reason)]);
  return check("tamper/no-tests-ran", [{ rule: "tamper/no-tests-ran", file: ".", line: 0, msg: "source changed, no test touched or found; add/refer a test or qg:no-test <reason>" }]);
}

const noTestReason = (text: string) => /(?:^|\s)qg:no-test\s+(\S.*)$/m.exec(text)?.[1].trim() ?? "";

