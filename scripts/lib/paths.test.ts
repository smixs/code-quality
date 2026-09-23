// Paths and runtime: where reports land, which base branch is compared against, and that the skill
// works from any install folder (hooks, adapters and the pi extension resolve their own script).
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptPath } from "../../adapters/invoke.ts";
import { buildOpts, readArgs } from "./config.ts";
import { adapterById, prePushTestCommand } from "./lang.ts";

const SKILL = join(import.meta.dir, "../..");
const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "qg-paths-"));
  dirs.push(dir);
  return dir;
};
const testHome = join(tmp(), "code-quality-home");
process.env.CODE_QUALITY_HOME = testHome;
const testEnv = { ...process.env, CODE_QUALITY_HOME: testHome };
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: testEnv });
const commit = (repo: string, message: string) => sh(repo, `git add -A && git -c user.name=t -c user.email=t@t commit -qm ${JSON.stringify(message)}`);

function docsRepo(toml: string) {
  const repo = tmp();
  writeFileSync(join(repo, ".quality.toml"), toml);
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n.quality-out/\n");
  writeFileSync(join(repo, "README.md"), "# a\n");
  sh(repo, "git init -q");
  commit(repo, "init");
  return repo;
}

describe("[project] out_dir", () => {
  test("the report, the baseline and the jev log follow the configured directory", () => {
    const repo = docsRepo('[project]\nbase = "HEAD"\nout_dir = ".quality-out"\n');
    const o = buildOpts(readArgs(["check", "--repo", repo, "--no-deps"]));
    expect([o.outDir, o.out, o.baseline.endsWith(".quality-out/baseline.json")]).toEqual([".quality-out", join(repo, ".quality-out"), true]);
    writeFileSync(join(repo, "README.md"), "# a\n\nb\n");
    const run = spawnSync(process.execPath, [join(SKILL, "scripts/quality.ts"), "check", "--repo", repo, "--no-deps"], { encoding: "utf8" });
    expect([run.status, existsSync(join(repo, ".quality-out/check.md")), existsSync(join(repo, ".scratch/quality"))]).toEqual([0, true, false]);
  }, 120_000);

  test("the default is .scratch/quality", () => {
    const o = buildOpts(readArgs(["check", "--repo", docsRepo('[project]\nbase = "HEAD"\n'), "--no-deps"]));
    expect(o.outDir).toBe(".scratch/quality");
  });
});

describe("project.base", () => {
  // A real remote of this repo: origin/HEAD only means something when the histories are related.
  const withRemote = (branch: string) => {
    const repo = docsRepo("[project]\n");
    sh(repo, `git branch -M ${branch}`);
    const origin = join(tmp(), "origin.git");
    sh(repo, `git clone -q --bare . ${JSON.stringify(origin)} && git remote add origin ${JSON.stringify(origin)} && git fetch -q origin`);
    return repo;
  };

  test("origin/HEAD decides the base when the config does not", () => {
    const repo = withRemote("trunk");
    sh(repo, "git remote set-head origin -a");
    const o = buildOpts(readArgs(["check", "--repo", repo, "--no-deps"]));
    expect([o.base, o.baseAuto]).toEqual(["origin/trunk", true]);
  }, 60_000);

  test("without origin/HEAD the usual names are tried in order", () => {
    const repo = withRemote("master");
    sh(repo, "git remote set-head origin -d");
    expect(buildOpts(readArgs(["check", "--repo", repo, "--no-deps"])).base).toBe("origin/master");
    const local = docsRepo("[project]\n");
    sh(local, "git branch -M main");
    expect(buildOpts(readArgs(["check", "--repo", local, "--no-deps"])).base).toBe("main");
  }, 60_000);

  test("the config wins and the report header says which base was used", () => {
    const repo = withRemote("trunk");
    sh(repo, "git remote set-head origin -a");
    writeFileSync(join(repo, ".quality.toml"), '[project]\nbase = "origin/trunk"\n');
    const configured = buildOpts(readArgs(["check", "--repo", repo, "--no-deps"]));
    expect([configured.base, configured.baseAuto]).toEqual(["origin/trunk", false]);
    writeFileSync(join(repo, ".quality.toml"), "[project]\n");
    commit(repo, "docs: base");
    const run = spawnSync(process.execPath, [join(SKILL, "scripts/quality.ts"), "check", "--repo", repo, "--no-deps"], { encoding: "utf8" });
    expect(readFileSync(join(repo, ".scratch/quality/check.md"), "utf8")).toContain("base origin/trunk (detected)");
    expect(run.status).toBe(0);
  }, 120_000);
});

describe("install folder", () => {
  test("the pi extension resolves the script next to itself", () => {
    expect(scriptPath()).toBe(join(SKILL, "scripts/quality.ts"));
    expect(existsSync(scriptPath())).toBe(true);
  });

  test("hooks installed from a copy of the skill call that copy", () => {
    const install = join(tmp(), "code-quality");
    mkdirSync(install, { recursive: true });
    for (const dir of ["scripts", "git-hooks", "rules", "adapters", "skills"]) cpSync(join(SKILL, dir), join(install, dir), { recursive: true });
    const repo = docsRepo('[project]\nbase = "HEAD"\n');
    const installed = spawnSync(process.execPath, [join(install, "scripts/quality.ts"), "install-hooks", repo], { encoding: "utf8", env: testEnv });
    expect(installed.stdout).toContain(join(testHome, "git-hooks"));
    writeFileSync(join(repo, "README.md"), "# a\n\nb\n");
    const committed = commit(repo, "docs: second line");
    expect([committed.status, existsSync(join(repo, ".scratch/quality/check.md"))]).toEqual([0, true]);
    const next = join(tmp(), "code-quality-next");
    mkdirSync(next, { recursive: true });
    for (const dir of ["scripts", "git-hooks", "rules", "adapters", "skills"]) cpSync(join(SKILL, dir), join(next, dir), { recursive: true });
    spawnSync(process.execPath, [join(next, "scripts/quality.ts"), "check", "--if-configured", "--repo", repo], { encoding: "utf8", env: testEnv });
    expect(readFileSync(join(testHome, "root"), "utf8").trim()).toBe(realpathSync(next));
    writeFileSync(join(repo, "README.md"), "# a\n\nb\n\nc\n");
    expect(commit(repo, "docs: third line").status).toBe(0);
  }, 180_000);
});

describe("test commands", () => {
  test("the pre-push command comes from the language adapter", () => {
    expect(prePushTestCommand(adapterById("py"))).toBe('uv run --with pytest pytest -q {files}');
    expect(prePushTestCommand(adapterById("ts"))).toBe("node --test {files}");
    expect(prePushTestCommand(adapterById("java"))).toBe(prePushTestCommand(adapterById("ts")));
  });
});
