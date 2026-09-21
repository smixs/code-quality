// The external-tool registry: one place for pinned versions, binary names and install hints.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToml } from "./config.ts";
import { adapterById } from "./lang.ts";
import { installHint, npmSpec, packageSpec, toolBinary, TOOLS, toolsDir } from "./tools.ts";

describe("tool registry", () => {
  test("every tool has a darwin and a linux hint, and no linux hint says brew", () => {
    const entries = Object.entries(TOOLS);
    expect(entries.length).toBeGreaterThan(0);
    const missing = entries.filter(([, tool]) => !tool.install.darwin || !tool.install.linux).map(([id]) => id);
    const brewOnLinux = entries.filter(([, tool]) => tool.install.linux.includes("brew")).map(([id]) => id);
    expect([missing, brewOnLinux]).toEqual([[], []]);
  });

  test("the hint follows the platform and win32 falls back to the linux one", () => {
    expect(installHint("gitleaks", {}, "darwin")).toBe("brew install gitleaks");
    expect(installHint("gitleaks", {}, "linux")).not.toContain("brew");
    expect(installHint("semgrep", {}, "win32")).toBe(installHint("semgrep", {}, "linux"));
  });

  test("pinned versions come from the registry and [tools] overrides one of them", () => {
    expect(npmSpec("jscpd")).toBe("jscpd@5.2.1");
    expect(npmSpec("jscpd", { jscpd: "5.3.0" })).toBe("jscpd@5.3.0");
    expect(packageSpec("lizard")).toBe("lizard==1.24.0");
    expect(packageSpec("lizard", { lizard: "1.25.0" })).toBe("lizard==1.25.0");
  });

  test("a path override replaces the binary, a bare value stays a version", () => {
    expect(toolBinary("gitleaks")).toBe("gitleaks");
    expect(toolBinary("gitleaks", { gitleaks: "/opt/bin/gitleaks" })).toBe("/opt/bin/gitleaks");
    expect(npmSpec("jscpd", { jscpd: "/opt/bin/jscpd" })).toBe("jscpd@5.2.1");
    expect(toolBinary("ast-grep", { "ast-grep": "/opt/bin/ast-grep" })).toBe("/opt/bin/ast-grep");
  });

  test("an unknown tool id is an error naming it", () => {
    expect(() => npmSpec("no-such-tool")).toThrow("unknown tool no-such-tool");
  });

  test("an unknown key in [tools] is a config error naming the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "qg-tools-"));
    const file = join(dir, ".quality.toml");
    writeFileSync(file, '[tools]\njscpd = "5.3.0"\nno-such-tool = "1.0.0"\n');
    expect(() => loadToml(file)).toThrow("unknown tool id(s) in [tools]: no-such-tool");
    writeFileSync(file, '[tools]\njscpd = "5.3.0"\n');
    expect(loadToml(file).tools).toEqual({ jscpd: "5.3.0" });
  });

  test("the language adapters take their install hints from the registry", () => {
    expect(adapterById("java")!.form.install).toBe(installHint("pmd"));
    expect(adapterById("swift")!.form.install).toBe(installHint("swiftlint"));
    expect(adapterById("ts")!.audit.install).toBe(installHint("osv-scanner"));
  });

  test("the npm tool cache: QG_TOOLS wins, then [project] tools_dir, then the platform default", () => {
    expect(toolsDir("", { QG_TOOLS: "/tmp/qg" }, "darwin")).toBe("/tmp/qg");
    expect(toolsDir("/srv/cache", {}, "linux")).toBe("/srv/cache");
    expect(toolsDir("", { HOME: "/home/t" }, "linux")).toBe("/home/t/.cache/quality-gate");
    expect(toolsDir("", { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" }, "win32")).toBe("C:\\Users\\t\\AppData\\Local/quality-gate");
  });
});
