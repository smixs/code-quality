// eslint form rules on changed functions: cognitive complexity, depth, params, length.
// Runs through the eslint Linter API with an in-memory config; the repo config is never read or written.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "./config.ts";
import { ensureTools, isChanged, loadEslint, type Range, TOOLS, TS_GLOB, walk } from "./crap.ts";
import type { Changes } from "./diff.ts";
import { check, type Finding } from "./util.ts";

export const SONARJS = "eslint-plugin-sonarjs@4.2.1";
const FORM_RULES = new Set(["sonarjs/cognitive-complexity", "max-depth", "max-params", "max-lines-per-function"]);

function sonarjs() {
  ensureTools([SONARJS]);
  const mod = createRequire(join(TOOLS, "package.json"))("eslint-plugin-sonarjs");
  return mod.default ?? mod;
}

function formConfig(o: Opts, parser: unknown) {
  const t = o.toml.thresholds;
  const rules = {
    "sonarjs/cognitive-complexity": ["error", t.cognitive_complexity],
    "max-depth": ["error", t.max_depth],
    "max-params": ["error", t.max_params],
    "max-lines-per-function": ["error", { max: t.max_lines_per_function, skipBlankLines: true, skipComments: true }],
  };
  return [{ files: [TS_GLOB], languageOptions: { parser }, plugins: { sonarjs: sonarjs() }, rules }];
}

// Innermost function that holds the line: the latest start wins, so a head-line report maps to its own function.
function owner(ranges: Range[], line: number) {
  const holding = ranges.filter((r) => r.start <= line && line <= r.end);
  return holding.sort((a, b) => b.start - a.start)[0];
}

function touchedMessage(file: string, ranges: Range[], ch: Changes, line: number) {
  const r = owner(ranges, line) ?? { start: line, end: line, col: 0, nested: [] };
  return isChanged({ ...r, file }, ch);
}

function lintOne(ctx: { o: Opts; linter: any; config: object[]; ch: Changes }, file: string): Finding[] {
  const path = join(ctx.o.repo, file);
  const msgs = ctx.linter.verify(readFileSync(path, "utf8"), ctx.config, { filename: path });
  const ast = ctx.linter.getSourceCode()?.ast;
  if (!ast) return [{ rule: "form", file, line: 1, msg: "eslint could not parse the file" }];
  const ranges: Range[] = [];
  walk(ast, null, ranges);
  // Only our rules: inline eslint-disable comments for rules outside this config report too.
  const mine = msgs.filter((m: any) => FORM_RULES.has(m.ruleId) && touchedMessage(file, ranges, ctx.ch, m.line));
  return mine.map((m: any) => ({ rule: `form/${m.ruleId}`, file, line: m.line, msg: m.message }));
}

export function formCheck(o: Opts, ch: Changes, files: string[]) {
  if (!o.langs.some((item) => item.adapter.id === "ts")) return check("form", []);
  const todo = files.filter((f) => ch.has(f) && /\.[cm]?[jt]sx?$/.test(f));
  if (!todo.length) return check("form", []);
  const { Linter, parser } = loadEslint(o.repo);
  const ctx = { o, linter: new Linter({ configType: "flat", cwd: o.repo }), config: formConfig(o, parser), ch };
  return check("form", todo.flatMap((f) => lintOne(ctx, f)));
}
