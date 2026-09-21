// Options = CLI flag, else <repo>/.quality.toml (a worktree falls back to its main checkout's), else default. Unknown toml keys fail fast.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { adapterById, detectLanguageRoots, validateRegistryUrls } from "./lang.ts";
import { validateToolOverrides } from "./tools.ts";
import { mainCheckout, run, splitList } from "./util.ts";

export const CONFIG_FILE = ".quality.toml";

// One bar everywhere (owner, 18.09.2026): changed functions gate on cc/CRAP; repo mean is a warning threshold.
export const DEFAULTS = {
  // base "" = detect from the remote (see detectBase); out_dir holds every report this gate writes.
  project: { language: "" as string | string[], src: ["."], base: "", test_cmd: "", tools_dir: "", out_dir: ".scratch/quality" },
  thresholds: {
    max_cc: 10,
    max_crap: 30,
    max_mean_crap: 5,
    mean_tolerance: 0.01,
    cognitive_complexity: 15,
    max_depth: 4,
    max_params: 4,
    max_lines_per_function: 80,
    dup_min_tokens: 70,
    diff_coverage: 0.8,
    min_release_age_days: 1,
  },
  layers: { forbid: [] as string[] },
  // Free-form: the keys are tool ids from tools.ts, the values a version or a binary path.
  tools: {} as Record<string, string>,
  knip: { ignore: [] as string[] },
  glossary: { path: "", marker: "_Avoid_:", allow: [] as string[], globs: ["**/*.md"], commit_msg: true },
  docs: { globs: ["*.md", "docs/**/*.md"], history_globs: ["docs/adr/**", "CHANGELOG.md", "**/CHANGELOG.md"] },
  escalate: { paths: [] as string[] },
  secrets: { allow_users: [] as string[] },
  // registry_urls: ecosystem -> URL template for the lock-age lookup (a mirror; "" = no registry).
  security: { gitleaks: true, audit: true, registry_urls: {} as Record<string, string> },
  hooks: { pre_push_test_cmd: "", pre_push_timeout: 60, pre_push_max_tests: 40 },
  // Jev notes never block (owner decision 3). The first two questions and thresholds are from pilot 2 (18.09.2026).
  review: {
    jev: false,
    llm: false,
    // Provider, endpoint, key variable and model: empty = the default of the resolved provider (jev.ts).
    jev_provider: "auto",
    jev_url: "",
    jev_key_env: "",
    jev_model: "",
    jev_max_states: 12,
    textual_test: true,
    textual_test_threshold: 0.85,
    error_path_tested: true,
    error_path_tested_threshold: 0.5,
    assertion_weakened: true,
    assertion_weakened_threshold: 0.7,
    mock_hides_behavior: true,
    mock_hides_behavior_threshold: 0.7,
    property_is_tautology: true,
    property_tautology_threshold: 0.7,
  },
};

type Toml = typeof DEFAULTS;

const FLAGS = {
  repo: { type: "string" },
  config: { type: "string" },
  baseline: { type: "string" },
  "test-cmd": { type: "string" },
  "skip-tests": { type: "boolean", default: false },
  "allow-red-tests": { type: "boolean", default: false },
  src: { type: "string" },
  "max-cc": { type: "string" },
  "max-crap": { type: "string" },
  base: { type: "string" },
  forbid: { type: "string", multiple: true },
  "knip-ignore": { type: "string", multiple: true },
  "update-baseline": { type: "boolean", default: false },
  "no-deps": { type: "boolean", default: false },
  staged: { type: "boolean", default: false },
  since: { type: "string" },
  all: { type: "boolean", default: false },
  "if-configured": { type: "boolean", default: false },
} as const;

export function readArgs(argv = process.argv.slice(2)) {
  return parseArgs({ args: argv, options: FLAGS, allowPositionals: true });
}

export type Args = ReturnType<typeof readArgs>;
export type Opts = ReturnType<typeof buildOpts>;

function validate(t: Record<string, any>, file: string) {
  for (const [section, body] of Object.entries(t)) {
    const known = (DEFAULTS as Record<string, object>)[section];
    if (!known) throw new Error(`${file}: unknown section [${section}]`);
    if (section === "tools") continue;
    const bad = Object.keys(body).filter((k) => !(k in known));
    if (bad.length) throw new Error(`${file}: unknown key(s) in [${section}]: ${bad.join(", ")}`);
  }
  validateToolOverrides(t.tools, file);
  validateRegistryUrls(t.security?.registry_urls, file);
  validateLanguages(t.project?.language, file);
}

function validateLanguages(value: unknown, file: string) {
  if (value === undefined || value === "") return;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string")) throw new Error(`${file}: project.language must be a string, a string list, or empty`);
  for (const id of values) if (!adapterById(String(id))) throw new Error(`${file}: unknown project.language ${id}`);
}

export function loadToml(path: string): Toml {
  const raw = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  validate(raw, path);
  const merged: Record<string, object> = {};
  for (const [k, v] of Object.entries(DEFAULTS)) merged[k] = { ...v, ...(raw[k] ?? {}) };
  return merged as Toml;
}

// A worktree without its own .quality.toml reads the main checkout's, like the baseline: the file
// may be untracked (public repo), and then no worktree would have it. "" = repo not configured.
export function repoConfigFile(repo: string) {
  const own = join(repo, CONFIG_FILE);
  if (existsSync(own)) return own;
  const main = join(mainCheckout(repo), CONFIG_FILE);
  return existsSync(main) ? main : "";
}

function configPath(repo: string, flag: string | undefined) {
  return flag ? resolve(flag) : repoConfigFile(repo);
}

const num = (flag: string | undefined, fallback: number) => (flag === undefined ? fallback : Number(flag));
const listOr = (flag: string[] | undefined, fallback: string[]) => (flag?.length ? splitList(flag) : fallback);

function scopeOf(v: Args["values"]) {
  if (v.all) return { kind: "all" as const, rev: "" };
  if (v.staged) return { kind: "staged" as const, rev: "" };
  if (v.since) return { kind: "since" as const, rev: v.since };
  return { kind: "base" as const, rev: "" };
}

type V = Args["values"];

function pathsOf(v: V, t: Toml, repo: string) {
  const outDir = t.project.out_dir || DEFAULTS.project.out_dir;
  const baseline = v.baseline ? resolve(v.baseline) : join(mainCheckout(repo), outDir, "baseline.json");
  const langs = detectLanguageRoots(repo, t.project.language);
  return { outDir, out: join(repo, outDir), baseline, langs, lang: langs[0]?.adapter.id ?? "ts" };
}

// What the remote publishes as its default branch; the usual names are the fallback. A configured
// project.base (or --base) always wins, and the report header says when the base was detected.
export function detectBase(repo: string) {
  const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  const known = ["origin/main", "origin/master", "main"];
  return known.find((ref) => run("git", ["rev-parse", "-q", "--verify", ref], repo).code === 0) ?? "origin/main";
}

function projectOf(v: V, t: Toml, repo: string) {
  const configured = v.base ?? t.project.base;
  return {
    dirs: listOr(v.src ? [v.src] : undefined, t.project.src),
    base: configured || detectBase(repo),
    baseAuto: !configured,
    testCmd: v["test-cmd"] ?? t.project.test_cmd,
  };
}

function rulesOf(v: V, t: Toml) {
  return {
    forbid: listOr(v.forbid, t.layers.forbid),
    knipIgnore: listOr(v["knip-ignore"], t.knip.ignore),
    maxCc: num(v["max-cc"], t.thresholds.max_cc),
    maxCrap: num(v["max-crap"], t.thresholds.max_crap),
  };
}

export function buildOpts(args: Args) {
  const v = args.values;
  const repo = resolve(v.repo ?? process.cwd());
  const cfgFile = configPath(repo, v.config);
  const t = cfgFile ? loadToml(cfgFile) : DEFAULTS;
  const entry = args.positionals[0] ?? "full";
  return { repo, cfgFile, toml: t, ...pathsOf(v, t, repo), ...projectOf(v, t, repo), ...rulesOf(v, t), scope: scopeOf(v), flags: v, entry };
}
