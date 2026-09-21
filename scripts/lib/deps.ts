// dependency-cruiser (cycles, layers) and knip (dead code), temp configs under [project] out_dir.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "./config.ts";
import { TS_SKIP } from "./crap.ts";
import { npmSpec } from "./tools.ts";
import { run } from "./util.ts";

const EXT_GLOB = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

export type Cycle = { key: string; text: string };
export type Deps = { error: string; cycles: Cycle[]; layers: string[]; modules?: number };
export type Knip = { error: string; counts: Record<string, number>; files: string[]; exports: string[] };

function depConfig(o: Opts) {
  const forbidden: object[] = [{ name: "no-circular", severity: "error", from: {}, to: { circular: true } }];
  for (const rule of o.forbid) {
    const [from, to] = rule.split(":");
    forbidden.push({ name: `layer:${rule}`, severity: "error", from: { path: from }, to: { path: to } });
  }
  const tsConfig = existsSync(join(o.repo, "tsconfig.json")) ? { fileName: join(o.repo, "tsconfig.json") } : undefined;
  const options = { doNotFollow: { path: "node_modules" }, exclude: { path: TS_SKIP.source }, tsPreCompilationDeps: true, tsConfig };
  const path = join(o.out, "depcruise.cjs");
  writeFileSync(path, `module.exports = ${JSON.stringify({ forbidden, options }, null, 1)};\n`);
  return path;
}

export function depcruise(o: Opts): Deps {
  const outFile = join(o.out, "depcruise.json");
  rmSync(outFile, { force: true });
  const pins = ["-p", npmSpec("dependency-cruiser", o.toml.tools), "-p", npmSpec("typescript", o.toml.tools)];
  const args = ["-y", ...pins, "depcruise", "--config", depConfig(o), "--output-type", "json", "--output-to", outFile, ...o.dirs];
  const r = run("npx", args, o.repo, { timeout: 600_000 });
  writeFileSync(join(o.out, "depcruise.log"), r.out + r.err);
  if (!existsSync(outFile)) return { error: `depcruise failed (exit ${r.code}), see depcruise.log`, cycles: [], layers: [] };
  const summary = JSON.parse(readFileSync(outFile, "utf8")).summary;
  return { ...summarizeDeps(summary.violations ?? []), modules: summary.totalCruised };
}

function summarizeDeps(violations: any[]) {
  const cycles = new Map<string, string>();
  const layers = new Set<string>();
  for (const v of violations) {
    if (v.rule.name !== "no-circular") layers.add(`${v.rule.name}: ${v.from} -> ${v.to}`);
    else addCycle(cycles, v);
  }
  return { error: "", cycles: [...cycles].map(([key, text]) => ({ key, text })), layers: [...layers] };
}

function addCycle(cycles: Map<string, string>, v: any) {
  const names: string[] = [v.from, ...(v.cycle ?? []).map((c: any) => c.name ?? c)];
  const uniq = [...new Set(names)];
  cycles.set([...uniq].sort().join("|"), uniq.join(" -> "));
}

const inDir = (d: string, glob: string) => (d === "." ? glob : `${d}/${glob}`);

// Project = --src; entry = knip defaults at the root and in each --src dir, plus test files: without a
// test script in package.json no knip plugin sees them, and every new test would read as unused.
function knipConfig(o: Opts) {
  const roots = [...new Set([".", "src", ...o.dirs])].map((d) => inDir(d, `{index,cli,main}.${EXT_GLOB}`));
  const entry = [...roots, ...o.dirs.map((d) => inDir(d, `**/*.{test,spec}.${EXT_GLOB}`))];
  const cfg = { entry, project: o.dirs.map((d) => inDir(d, `**/*.${EXT_GLOB}`)), ignore: [...o.knipIgnore, ".scratch/**"] };
  const path = join(o.out, "knip.config.json");
  writeFileSync(path, JSON.stringify(cfg, null, 1));
  return path;
}

export function knip(o: Opts): Knip {
  if (!existsSync(join(o.repo, "package.json"))) return { error: "", counts: {}, files: [], exports: [] };
  const r = run("npx", ["-y", npmSpec("knip", o.toml.tools), "--config", knipConfig(o), "--reporter", "json", "--no-exit-code"], o.repo, { timeout: 600_000 });
  writeFileSync(join(o.out, "knip.json"), r.out);
  writeFileSync(join(o.out, "knip.log"), r.err);
  try {
    return knipSummary(JSON.parse(r.out));
  } catch {
    return { error: `knip failed (exit ${r.code}), see knip.log`, counts: {}, files: [], exports: [] };
  }
}

function knipSummary(j: any): Knip {
  const issues: any[] = j.issues ?? [];
  const counts: Record<string, number> = {};
  for (const [k, v] of issues.flatMap((i) => Object.entries(i).filter(([, x]) => Array.isArray(x)))) counts[k] = (counts[k] ?? 0) + (v as any[]).length;
  const names = (k: string) => issues.flatMap((i) => (i[k] ?? []).map((x: any) => (k === "files" ? x.name : `${i.file}:${x.name}`)));
  return { error: "", counts, files: names("files"), exports: [...names("exports"), ...names("types")] };
}
