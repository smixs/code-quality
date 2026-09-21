import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Opts } from "./config.ts";
import { WHOLE, type Changes } from "./diff.ts";
import { testHunks } from "./jev.ts";
import { ADAPTERS, adapterById, adapterForFile, detectLanguageRoots, isTestFile, matchesTestPattern, REGISTRIES, registryLookup } from "./lang.ts";

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

describe("package registries", () => {
  const sample: Record<string, [string, unknown, string]> = {
    npm: ["left-pad", { time: { "1.3.0": "2020-01-01T00:00:00.000Z" } }, "2020-01-01T00:00:00.000Z"],
    pypi: ["requests", { urls: [{ upload_time_iso_8601: "2020-01-01T00:00:00.000Z" }] }, "2020-01-01T00:00:00.000Z"],
    crates: ["serde", { version: { created_at: "2020-01-01T00:00:00.000Z" } }, "2020-01-01T00:00:00.000Z"],
    go: ["github.com/a/b", { Version: "v1.3.0", Time: "2020-01-01T00:00:00Z" }, "2020-01-01T00:00:00Z"],
    rubygems: ["rails", [{ number: "1.3.0", created_at: "2020-01-01T00:00:00.000Z" }], "2020-01-01T00:00:00.000Z"],
    packagist: ["acme/lib", { packages: { "acme/lib": [{ version: "1.3.0", time: "2020-01-01T00:00:00+00:00" }] } }, "2020-01-01T00:00:00+00:00"],
    pub: ["http", { versions: [{ version: "1.3.0", published: "2020-01-01T00:00:00.000Z" }] }, "2020-01-01T00:00:00.000Z"],
    nuget: ["Newtonsoft.Json", { catalogEntry: { published: "2020-01-01T00:00:00.000Z" } }, "2020-01-01T00:00:00.000Z"],
    maven: ["com.acme:lib", { response: { docs: [{ timestamp: 1577836800000 }] } }, "2020-01-01T00:00:00.000Z"],
    "deps.dev": ["left-pad", { publishedAt: "2020-01-01T00:00:00.000Z" }, "2020-01-01T00:00:00.000Z"],
  };

  test("every ecosystem has a URL template and reads the publication time from it", () => {
    for (const [id, [name, json, expected]] of Object.entries(sample)) {
      const lookup = registryLookup({ registry: id, name, version: "1.3.0", system: "NPM" })!;
      const parts = name.split(":").map((part) => encodeURIComponent(part).replace(/%2F/g, "/"));
      expect([id, lookup.url.includes("{"), parts.every((part) => lookup.url.includes(part))]).toEqual([id, false, true]);
      expect([id, lookup.date(json)]).toEqual([id, expected]);
    }
  });

  test("the go proxy and deps.dev carry version and system in the path", () => {
    expect(registryLookup({ registry: "go", name: "github.com/a/b", version: "v1.3.0" })!.url).toBe("https://proxy.golang.org/github.com/a/b/@v/v1.3.0.info");
    expect(registryLookup({ registry: "deps.dev", name: "left-pad", version: "1.3.0", system: "NPM" })!.url).toContain("/systems/NPM/packages/left-pad/versions/1.3.0");
  });

  test("an unknown or disabled ecosystem has no lookup", () => {
    expect(registryLookup({ registry: "conan", name: "zlib", version: "1.3.0" })).toBeNull();
    expect(registryLookup({ registry: "npm", name: "left-pad", version: "1.3.0", urls: { npm: "" } })).toBeNull();
  });

  test("[security] registry_urls points an ecosystem at a mirror", () => {
    const lookup = registryLookup({ registry: "npm", name: "left-pad", version: "1.3.0", urls: { npm: "https://mirror.local/npm/{name}" } })!;
    expect(lookup.url).toBe("https://mirror.local/npm/left-pad");
  });

  test("every language adapter names a registry that exists", () => {
    for (const adapter of ADAPTERS) expect([adapter.id, adapter.depAge.registry in REGISTRIES]).toEqual([adapter.id, true]);
  });
});
