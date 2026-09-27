// Acceptance selection is the closure: every test that reaches a changed file through imports,
// re-exports, dynamic imports, require and test path literals, with modules resolved the way the
// project resolves them (nearest tsconfig paths, workspace packages). pre-push stays names + direct.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildOpts, readArgs } from "./config.ts";
import { ACCEPTANCE, touchedTestSelection } from "./touched.ts";
import { cleanup, commit, git, laneEnv, nodeRepo, read, SCRIPT, TOML, write } from "./testkit.ts";

afterAll(cleanup);

const A = "apps/a/src";
// Shaped like the Splendor admin: apps/a/tsconfig.json declares "@/*" and extends the root config
// (no baseUrl); a render test reaches the screen through a harness path literal.
const FILES: Record<string, string> = {
  "tsconfig.json": '{\n  // the root config: no paths\n  "compilerOptions": { "strict": true }\n}\n',
  "apps/a/tsconfig.json": '{ "extends": "../../tsconfig.json", "compilerOptions": { "jsx": "react-jsx", "paths": { "@/*": ["./src/*"] } } }\n',
  [`${A}/lib/utils.ts`]: "export const cn = (x: string) => x;\n",
  [`${A}/lib/utils.test.ts`]: 'import { cn } from "./utils";\ncn("a");\n',
  [`${A}/lib/cn.test.ts`]: 'const { cn } = require("./utils.ts");\ncn("a");\n',
  [`${A}/components/ui/button.tsx`]: 'import { cn } from "@/lib/utils";\nexport const Button = (x: string) => cn(x);\n',
  [`${A}/components/ui/button-touch-target.test.ts`]: 'import { Button } from "@/components/ui/button";\nButton("a");\n',
  [`${A}/panels/Panel.tsx`]: 'import { Button } from "@/components/ui/button";\nexport const Panel = () => Button("p");\n',
  [`${A}/panels/index.ts`]: 'export { Panel } from "./Panel";\n',
  [`${A}/Screen.tsx`]: 'import { Panel } from "./panels";\nexport const Screen = () => Panel();\n',
  [`${A}/Screen.render-harness.tsx`]: 'const { Screen } = await import("./Screen");\nScreen();\n',
  [`${A}/run-harness.ts`]: "export const runHarness = (path: string) => path;\n",
  [`${A}/Screen.render.test.ts`]: 'import { resolve } from "node:path";\nimport { runHarness } from "./run-harness";\nrunHarness(resolve(import.meta.dir, "Screen.render-harness.tsx"));\n',
  [`${A}/other.ts`]: "export const other = 1;\n",
  [`${A}/other.test.ts`]: 'import { other } from "./other";\nother;\n',
  [`${A}/cycle/a.ts`]: 'import { b } from "./b";\nexport const a = () => b();\n',
  [`${A}/cycle/b.ts`]: 'import { a } from "./a";\nimport { cn } from "@/lib/utils";\nexport const b = (): string => (Math.random() > 2 ? a() : cn("b"));\n',
  [`${A}/cycle/cycle.test.ts`]: 'import { a } from "./a";\na();\n',
  "packages/ui/package.json": '{ "name": "@x/ui", "exports": { ".": "./src/index.ts" } }\n',
  "packages/ui/src/index.ts": 'export { Chip } from "./chip";\n',
  "packages/ui/src/chip.ts": "export const Chip = () => 1;\n",
  "packages/ui/src/button.ts": "export const UiButton = () => 1;\n",
  "packages/kit/package.json": '{ "name": "kit", "exports": { ".": { "import": "./lib/main.ts", "default": "./dist/main.js" } } }\n',
  "packages/kit/lib/main.ts": "export const kit = 1;\n",
  [`${A}/ui.test.ts`]: 'import { Chip } from "@x/ui";\nChip();\n',
  [`${A}/ui-button.test.ts`]: 'import { UiButton } from "@x/ui/button";\nUiButton();\n',
  [`${A}/kit.test.ts`]: 'import { kit } from "kit";\nkit;\n',
  // paths only in the base config reached through extends; its baseUrl is ./src
  "apps/b/tsconfig.json": '{ "extends": "./tsconfig.base.json" }\n',
  "apps/b/tsconfig.base.json": '{ "compilerOptions": { "baseUrl": "./src", "paths": { "~/*": ["*"] } } }\n',
  "apps/b/src/lib/util.ts": "export const util = 1;\n",
  "apps/b/lib/util.ts": "export const util = 2;\n",
  "lib/util.ts": "export const util = 3;\n",
  "apps/b/src/feature.test.ts": 'import { util } from "~/lib/util";\nutil;\n',
};

function closureRepo(hooks = "") {
  const repo = nodeRepo(FILES, "");
  write(repo, ".quality.toml", `${TOML.replace('src = ["src"]', 'src = ["apps", "packages", "lib"]')}${hooks}`);
  commit(repo, "config");
  return repo;
}

const accept = (repo: string, file: string) => {
  const s = touchedTestSelection(buildOpts(readArgs(["check", "--repo", repo])), [file], ACCEPTANCE);
  return { tests: [...s.tests].sort(), counts: [s.byName, s.byImport, s.further] };
};

describe("acceptance selection is the closure", () => {
  const repo = closureRepo();

  test("alias: the nearest tsconfig's @/* (extends the root, no baseUrl) reaches utils through button", () => {
    expect(accept(repo, `${A}/lib/utils.ts`).tests).toContain(`${A}/components/ui/button-touch-target.test.ts`);
  });

  test("alias: paths only in the base config reached through extends resolve against its baseUrl", () => {
    expect([accept(repo, "apps/b/src/lib/util.ts").tests, accept(repo, "apps/b/lib/util.ts").tests, accept(repo, "lib/util.ts").tests]).toEqual([["apps/b/src/feature.test.ts"], [], []]);
  });

  test("package: a workspace package by name (exports['.'], its import) and name/sub", () => {
    expect([accept(repo, "packages/ui/src/chip.ts").tests, accept(repo, "packages/ui/src/button.ts").tests, accept(repo, "packages/kit/lib/main.ts").tests]).toEqual([[`${A}/ui.test.ts`], [`${A}/ui-button.test.ts`], [`${A}/kit.test.ts`]]);
  });

  test("closure: test -> harness (path literal) -> screen -> barrel re-export -> panel -> button -> util", () => {
    const s = accept(repo, `${A}/lib/utils.ts`);
    expect(s.tests).toEqual([`${A}/Screen.render.test.ts`, `${A}/components/ui/button-touch-target.test.ts`, `${A}/cycle/cycle.test.ts`, `${A}/lib/cn.test.ts`, `${A}/lib/utils.test.ts`]);
    expect(s.counts).toEqual([1, 1, 3]);
  });

  test("closure: an unrelated test is not selected; an import cycle ends", () => {
    expect([accept(repo, `${A}/cycle/a.ts`).tests, accept(repo, `${A}/other.ts`).tests]).toEqual([[`${A}/cycle/cycle.test.ts`], [`${A}/other.test.ts`]]);
    expect(accept(repo, `${A}/lib/utils.ts`).tests).not.toContain(`${A}/other.test.ts`);
  });
});

describe("pre-push keeps names and direct imports, capped", () => {
  test("hook pre-push on the same repo: the named test and the direct importer, capped at pre_push_max_tests", () => {
    const run = (max: number) => {
      const repo = closureRepo(`\n[hooks]\npre_push_test_cmd = 'printf "%s\\n" {files} > selected.txt'\npre_push_max_tests = ${max}\n`);
      const base = git(repo, "rev-parse", "HEAD");
      write(repo, `${A}/lib/utils.ts`, "export const cn = (x: string) => `${x}!`;\n");
      commit(repo, "utils");
      const ref = `refs/heads/${git(repo, "rev-parse", "--abbrev-ref", "HEAD")}`;
      const r = spawnSync(process.execPath, [SCRIPT, "hook", "pre-push", "--repo", repo, "--no-deps"], { input: `${ref} ${git(repo, "rev-parse", "HEAD")} ${ref} ${base}\n`, encoding: "utf8", env: laneEnv() });
      return [r.status, read(repo, "selected.txt").trim().split("\n").sort()];
    };
    expect(run(40)).toEqual([0, [`${A}/lib/cn.test.ts`, `${A}/lib/utils.test.ts`]]);
    expect(run(1)).toEqual([0, [`${A}/lib/utils.test.ts`]]);
  }, 60_000);
});
