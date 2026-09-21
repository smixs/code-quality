import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterChecks, adapterFindingKey, type AdapterToolKind, parseSarif, ratchetAdapterChecks } from "./adapter-tools.ts";
import { buildOpts, readArgs } from "./config.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(manifest: string, text: string) {
  const root = mkdtempSync(join(tmpdir(), "qg-adapter-"));
  dirs.push(root);
  writeFileSync(join(root, manifest), text);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  return root;
}

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  chmodSync(join(bin, name), 0o755);
}

function tools(root: string, bin: string, kinds: AdapterToolKind[]) {
  const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--src", "."]));
  return adapterChecks(o, kinds, { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
}

const rules = (checks: ReturnType<typeof adapterChecks>) => checks.flatMap((item) => item.findings.map((finding) => finding.rule));

describe("adapter tool runner", () => {
  test("parses the common SARIF result shape", () => {
    // SARIF 2.1 result/location shape used by PMD and documented by OASIS.
    const sarif = JSON.stringify({ runs: [{ results: [{
      ruleId: "UnusedPrivateMethod",
      message: { text: "unused helper" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/App.java" }, region: { startLine: 12 } } }],
    }] }] });
    expect(parseSarif(sarif, "dead", "/repo")).toEqual([
      { rule: "dead/UnusedPrivateMethod", file: "src/App.java", line: 12, msg: "unused helper" },
    ]);
  });

  test("runs Go cycle, deadcode JSON, form, and audit adapters from PATH", () => {
    const root = repo("go.mod", "module example.test/app\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    // `go list -json`, deadcode -json, and gocyclo README samples use these exact field orders.
    stub(bin, "go", `printf '%s\\n' '{"ImportPath":"example.test/a","DepsErrors":[{"ImportStack":["example.test/a","example.test/b","example.test/a"],"Err":"import cycle not allowed"}]}'`);
    stub(bin, "deadcode", `printf '%s\\n' '[{"Name":"main","Path":"example.test/app","Funcs":[{"Name":"unused","Position":{"File":"dead.go","Line":7,"Col":1}}]}]'`);
    stub(bin, "gocyclo", `printf '%s\\n' '12 quality Add a.go:3:1'`);
    stub(bin, "osv-scanner", `printf '%s\\n' '{"results":[{"source":{"path":"go.mod"},"packages":[{"package":{"name":"bad","version":"1.0.0"},"vulnerabilities":[{"id":"GO-2026-0001"}]}]}]}'; exit 1`);
    const checks = tools(root, bin, ["cycles", "dead", "form", "audit"]);
    expect(rules(checks)).toEqual(["deps/cycle", "dead/deadcode", "form/gocyclo", "deps/audit"]);
    expect(checks[2].findings[0]).toEqual(expect.objectContaining({ file: "a.go", line: 3, msg: "Add has complexity 12" }));
    const known = [adapterFindingKey(checks[1].findings[0], "go", "dead")];
    expect(rules(ratchetAdapterChecks(checks, known))).toEqual(["deps/cycle", "form/gocyclo", "deps/audit"]);
  });

  test("audits each discovered lockfile explicitly and prints one clean repo summary", () => {
    const root = repo("package.json", "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    mkdirSync(join(root, "crates/core"), { recursive: true });
    writeFileSync(join(root, "crates/core/Cargo.lock"), "# lock\n");
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--src", "."]));
    const calls: Array<[string, string[], string]> = [];
    const runner = ((command: string, args: string[], cwd: string) => {
      calls.push([command, args, cwd]);
      const packages = cwd === root ? 300 : 59;
      return { code: 0, out: '{"results":[]}', err: `Scanned lock file and found ${packages} packages` };
    }) as any;
    const checks = adapterChecks(o, ["audit"], { runner });
    expect(calls).toEqual([
      ["osv-scanner", ["scan", "source", "--format", "json", "-L", "Cargo.lock"], join(root, "crates/core")],
      ["osv-scanner", ["scan", "source", "--format", "json", "-L", "package-lock.json"], root],
    ]);
    expect(checks.map((item) => [item.name, item.findings.length, item.notices])).toEqual([
      ["deps/audit", 0, ["deps/audit: 0 finding(s) (359 packages, osv-scanner)"]],
    ]);
  });

  test("distinguishes a missing package source from an unavailable OSV database", () => {
    const root = repo("package.json", "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--src", "."]));
    const unavailable = (() => ({ code: 127, out: "", err: "unable to fetch OSV database" })) as any;
    const missing = (() => ({ code: 128, out: "", err: "No package sources found" })) as any;
    expect(adapterChecks(o, ["audit"], { runner: unavailable }).flatMap((item) => item.notices)).toEqual([
      "not run: deps/audit (OSV database unavailable)",
    ]);
    expect(adapterChecks(o, ["audit"], { runner: missing }).flatMap((item) => item.notices)).toEqual([
      "not run: deps/audit (osv-scanner: no packages found)",
    ]);
  });

  test("a lockfile with no extractable packages does not hide a successful repo scan", () => {
    const root = repo("package.json", "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    mkdirSync(join(root, "service"));
    writeFileSync(join(root, "service/requirements.txt"), "local-project\n");
    Bun.spawnSync(["git", "add", "package-lock.json", "service/requirements.txt"], { cwd: root });
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--src", "."]));
    const runner = ((_command: string, _args: string[], cwd: string) => cwd === root
      ? { code: 0, out: '{"results":[]}', err: "Scanned lock file and found 359 packages" }
      : { code: 128, out: "", err: "No package sources found" }) as any;
    expect(adapterChecks(o, ["audit"], { runner }).flatMap((item) => item.notices)).toEqual([
      "deps/audit: 0 finding(s) (359 packages, osv-scanner)",
    ]);
  });

  test("an old baseline gets one non-blocking update hint for all adapter findings", () => {
    const root = repo("go.mod", "module example.test/root\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    stub(bin, "go", `printf '%s\\n' '{"ImportPath":"example.test/root","DepsErrors":[{"ImportStack":["a","b","a"],"Err":"import cycle"}]}'`);
    stub(bin, "deadcode", `printf '%s\\n' '[{"Path":"example.test/root","Funcs":[{"Name":"unused","Position":{"File":"dead.go","Line":1}}]}]'`);
    const raw = tools(root, bin, ["cycles", "dead"]);
    const checks = ratchetAdapterChecks(raw, null);
    expect(checks.flatMap((item) => item.findings)).toEqual([]);
    expect(checks.flatMap((item) => item.notices)).toEqual([
      "baseline: no adapter tool list; run --update-baseline after updating code-quality; adapter findings not judged",
    ]);
  });

  test("runs Rust cargo machete and Clippy JSON adapters from PATH", () => {
    const root = repo("Cargo.toml", "[package]\nname='app'\nversion='0.1.0'\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Samples follow cargo-machete's README and Cargo's JSON compiler-message schema.
    stub(bin, "cargo", `
if [ "$1" = machete ]; then
  printf '%s\\n' '{"crates":[{"package_name":"app","manifest_path":"Cargo.toml","unused":["serde"]}]}'
else
  printf '%s\\n' '{"reason":"compiler-message","message":{"code":{"code":"clippy::too_many_arguments"},"level":"warning","message":"too many arguments","spans":[{"file_name":"src/lib.rs","line_start":4,"is_primary":true}]}}'
fi`);
    expect(rules(tools(root, bin, ["dead", "form"]))).toEqual([
      "dead/cargo-machete", "form/clippy::too_many_arguments",
    ]);
  });

  test("runs PMD SARIF adapters from PATH", () => {
    const root = repo("pom.xml", "<project/>\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    stub(bin, "pmd", `
case "$*" in
  *bestpractices*) rule=UnusedPrivateMethod ;;
  *) rule=ExcessiveMethodLength ;;
esac
printf '{"runs":[{"results":[{"ruleId":"%s","message":{"text":"pmd finding"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"src/App.java"},"region":{"startLine":9}}}]}]}]}\\n' "$rule"`);
    expect(rules(tools(root, bin, ["dead", "form"]))).toEqual([
      "dead/UnusedPrivateMethod", "form/ExcessiveMethodLength",
    ]);
  });

  test("parses documented text and real Ruff JSON through generic parsers", () => {
    const root = repo("pyproject.toml", "[project]\nname='app'\nversion='0.1.0'\n");
    const bin = join(root, "bin");
    mkdirSync(bin);
    // Vulture documents compiler-style text; the Ruff row follows installed Ruff --output-format json.
    stub(bin, "uvx", `
if [ "$1" = vulture ]; then
  printf '%s\\n' "mod.py:2: unused function 'unused' (60% confidence)"
else
  printf '%s\\n' '[{"cell":null,"code":"E722","end_location":{"column":7,"row":2},"filename":"mod.py","fix":null,"location":{"column":1,"row":2},"message":"Do not use bare except"}]'
fi`);
    const checks = tools(root, bin, ["dead", "form"]);
    expect(rules(checks)).toEqual(["dead/vulture", "form/E722"]);
    expect(checks.map((item) => item.findings[0]?.file)).toEqual(["mod.py", "mod.py"]);
    expect(checks[1].findings[0]?.line).toBe(2);
  });

  test("prints one missing-tool notice with the affected root count", () => {
    const root = repo("go.mod", "module example.test/root\n");
    const o = buildOpts(readArgs(["check", "--repo", root, "--all", "--src", "."]));
    const adapter = o.langs[0].adapter;
    const roots = ["services/a", "services/b"].map((path) => ({ adapter, root: path }));
    const runner = (() => ({ code: 127, out: "", err: "gocyclo: command not found" })) as any;
    const checks = adapterChecks(o, ["form"], { roots, runner });
    expect(checks.flatMap((item) => item.notices)).toEqual([
      "not run: form/gocyclo (gocyclo not found: go install github.com/fzipp/gocyclo/cmd/gocyclo@latest; roots: 2)",
    ]);
  });
});
