// Only the entry points agents call (agent-stop, guard-bash) move the machine's hook pointers; a copy
// run by hand (check, mutant, the full gate, hook ...) leaves hooks-root and root alone.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADD_NEG, ADD_TEST, cleanup, laneEnv, NEG_TEST, nodeRepo, nodeTest, quality, read, SCRIPT, tmp, write } from "./testkit.ts";

afterAll(cleanup);

const COPY = realpathSync(join(import.meta.dir, "../.."));

// A machine whose hooks point at an older copy (1.0.0), so this copy is newer.
function olderHooks() {
  const home = tmp("qg-home-");
  const old = realpathSync(tmp("qg-old-copy-"));
  writeFileSync(join(old, "package.json"), '{ "name": "code-quality", "version": "1.0.0" }\n');
  for (const name of ["hooks-root", "root"]) writeFileSync(join(home, name), `${old}\n`);
  return { home, old };
}

const pointers = (home: string) => ["hooks-root", "root"].map((name) => readFileSync(join(home, name), "utf8").trim());
const agent = (home: string, cmd: string, input: string) => spawnSync(process.execPath, [SCRIPT, cmd], { input, encoding: "utf8", env: laneEnv({ CODE_QUALITY_HOME: home }) });

describe("machine hooks follow the agent's copy", () => {
  test("check, mutant, the full gate and hook commit-msg from a newer copy leave hooks-root and root unchanged", () => {
    const { home, old } = olderHooks();
    const repo = nodeRepo({ "src/calc.ts": ADD_NEG, "src/calc.test.ts": nodeTest(ADD_TEST, NEG_TEST) });
    write(repo, ".quality.toml", read(repo, ".quality.toml").replace('base = "HEAD"', `base = "HEAD"\ntest_cmd = '''printf 'TN:\\nSF:src/calc.ts\\nDA:1,1\\nend_of_record\\n' > "$QG_LCOV"'''`));
    const env = { CODE_QUALITY_HOME: home };
    const message = join(tmp(), "COMMIT_EDITMSG");
    writeFileSync(message, "docs: a line\n");
    const runs = [
      quality(["check", "--repo", repo, "--no-deps"], env),
      quality(["mutant", "--repo", repo, "--file", "src/calc.ts", "--find=a + b", "--replace=a - b"], env),
      quality(["--repo", repo, "--no-deps"], env),
      quality(["hook", "commit-msg", message, "--repo", repo], env),
    ];
    expect([runs[1].stdout.trim(), pointers(home)]).toEqual(["MUTANT KILLED: 1 failing test(s) in src/calc.test.ts", [old, old]]);
  }, 120_000);

  test("guard-bash and agent-stop from that copy take the hooks", () => {
    for (const [cmd, input] of [["guard-bash", '{"tool_input":{"command":"true"}}'], ["agent-stop", JSON.stringify({ cwd: tmp(), session_id: "s" })]]) {
      const { home } = olderHooks();
      const r = agent(home, cmd, input);
      expect([r.status, pointers(home)]).toEqual([0, [COPY, COPY]]);
    }
  }, 60_000);
});

