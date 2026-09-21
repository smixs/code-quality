import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Opts } from "./config.ts";
import { WHOLE, type Changes } from "./diff.ts";
import { testHunks } from "./jev.ts";
import { ADAPTERS, adapterById, adapterForFile, detectLanguageRoots, isTestFile, matchesTestPattern } from "./lang.ts";

const dirs: string[] = [];

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "qg-lang-"));
  dirs.push(repo);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  return repo;
}

describe("language adapters", () => {
  test("define the complete language matrix as data", () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "ts", "py", "go", "rust", "java", "kotlin", "csharp", "swift", "php", "ruby", "cpp", "dart",
    ]);
    for (const adapter of ADAPTERS) {
      expect(adapter.detect.length).toBeGreaterThan(0);
      expect(adapter.testGlobs.length).toBeGreaterThan(0);
      expect(adapter.testPatterns.test.length).toBeGreaterThan(0);
      expect(adapter.testPatterns.assert.length).toBeGreaterThan(0);
      expect(adapter.coverage.command.length).toBeGreaterThan(0);
      expect(adapter.audit.install.length).toBeGreaterThan(0);
      expect(adapter.depAge.provider.length).toBeGreaterThan(0);
    }
  });

  test("detects every manifest root in a multilingual monorepo", () => {
    const repo = fixture({
      "package.json": "{}\n",
      "src/index.ts": "export const value = 1;\n",
      "services/api/go.mod": "module example.test/api\n",
      "services/api/main.go": "package main\n",
      "crates/core/Cargo.toml": "[package]\nname='core'\nversion='0.1.0'\n",
      "crates/core/src/lib.rs": "pub fn value() -> i32 { 1 }\n",
    });
    const roots = detectLanguageRoots(repo, "");
    expect(roots.map((item) => `${item.adapter.id}:${item.root}`)).toEqual([
      "ts:.", "rust:crates/core", "go:services/api",
    ]);
    expect(adapterForFile(roots, "services/api/main.go")?.id).toBe("go");
    expect(adapterForFile(roots, "crates/core/src/lib.rs")?.id).toBe("rust");
    expect(adapterForFile(roots, "src/index.ts")?.id).toBe("ts");
  });

  test("infers an unmanifested root language alongside manifested nested fixtures", () => {
    const repo = fixture({
      "scripts/check.ts": "export const check = true;\n",
      "fixtures/go/go.mod": "module example.test/fixture\n",
      "fixtures/go/value.go": "package fixture\n",
    });
    expect(detectLanguageRoots(repo, "").map((item) => `${item.adapter.id}:${item.root}`)).toEqual([
      "ts:.", "go:fixtures/go",
    ]);
  });

  test("an explicit language list keeps only requested adapters and uses their manifest roots", () => {
    const repo = fixture({
      "package.json": "{}\n",
      "go.mod": "module example.test/root\n",
      "nested/Cargo.toml": "[package]\nname='nested'\nversion='0.1.0'\n",
    });
    const roots = detectLanguageRoots(repo, ["go", "rust"]);
    expect(roots.map((item) => `${item.adapter.id}:${item.root}`)).toEqual(["go:.", "rust:nested"]);
  });

  test("routes test names and tamper markers through each adapter", () => {
    const cases = [
      ["go", "pkg/value_test.go", "t.Skip(\"later\")"],
      ["rust", "tests/value.rs", "#[ignore]"],
      ["java", "src/test/java/ValueTest.java", "@Disabled"],
      ["php", "tests/ValueTest.php", "$this->markTestSkipped('later');"],
      ["ruby", "spec/value_spec.rb", "skip 'later'"],
      ["dart", "test/value_test.dart", "test('value', () {}, skip: true);"],
    ] as const;
    for (const [id, file, line] of cases) {
      const adapter = adapterById(id)!;
      const roots = [{ adapter, root: "." }];
      expect([id, isTestFile(roots, file), matchesTestPattern(adapter, "skip", line)]).toEqual([id, true, true]);
    }
  });

  test("Jev receives a whole-file Go test hunk selected by the adapter glob", () => {
    const adapter = adapterById("go")!;
    const diff = { touched: new Set([WHOLE]), added: new Map([[1, "func TestValue(t *testing.T) {}"]]), removed: new Map(), hunks: [], deleted: false };
    const ch: Changes = new Map([["pkg/value_test.go", diff]]);
    const hunks = testHunks({ langs: [{ adapter, root: "." }], scope: { kind: "all" } } as Opts, ch);
    expect(hunks.map((hunk) => hunk.file)).toEqual(["pkg/value_test.go"]);
  });
});
