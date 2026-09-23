import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpts, DEFAULTS, type Opts, readArgs } from "./config.ts";
import { changes, type Changes } from "./diff.ts";
import { auditCheck, gitleaksCheck, lockAgeCheck, newPackageCheck, type SecurityDeps } from "./security.ts";
import { secretCheck } from "./text.ts";
import { installHint } from "./tools.ts";
import type { run } from "./util.ts";

const root = join(import.meta.dir, "../../.scratch/quality/security-tests");
mkdirSync(root, { recursive: true });
const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(root, "/case-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const options = (repo: string) => {
  const toml = structuredClone(DEFAULTS);
  const out = join(repo, ".scratch/quality");
  mkdirSync(out, { recursive: true });
  return { repo, out, base: "HEAD", scope: { kind: "base" }, toml } as Opts;
};

const fake = (fn: (...args: Parameters<typeof run>) => ReturnType<typeof run>, now = Date.UTC(2026, 8, 21, 12)) => ({ run: fn as typeof run, now: () => now } satisfies SecurityDeps);
const result = (code: number, out = "", err = "") => ({ code, out, err });

function added(file: string, text: string): Changes {
  const rows = text.split("\n");
  return new Map([[file, { touched: new Set(rows.map((_, i) => i + 1)), added: new Map(rows.map((row, i) => [i + 1, row])), removed: new Map(), hunks: [], deleted: false }]]);
}

describe("secret/gitleaks", () => {
  test("documents the installed blocking scanners in the dated security section", () => {
    const measurements = readFileSync(join(import.meta.dir, "../../skills/code-quality/references/measurements.md"), "utf8");
    const section = measurements.split("## Security, 21.09.2026")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("Gitleaks `8.30.1` and OSV Scanner `2.6.0` are installed");
    expect(section).toContain("Gitleaks findings block");
    expect(section).not.toContain("Gitleaks is not installed");
    expect(section).not.toContain("Bun audit");
  });

  test("passes when the binary reports no leaks", () => {
    const repo = tmp();
    let scanArgs: string[] = [];
    const deps = fake((_cmd, args) => {
      if (args[0] === "version") return result(0, "8.28.0");
      scanArgs = args;
      return result(0);
    });
    expect(gitleaksCheck(options(repo), deps).findings).toEqual([]);
    expect(scanArgs).toContain("--log-opts=HEAD..HEAD");
    const missing = fake(() => result(-1, "", "spawnSync gitleaks ENOENT"));
    expect(gitleaksCheck(options(tmp()), missing).notices).toEqual([`secret/gitleaks: not installed (${installHint("gitleaks")})`]);
  });

  test("blocks report findings without gitleaks:allow and does not print the secret", () => {
    const repo = tmp();
    const deps = fake((_cmd, args) => {
      if (args[0] === "version") return result(0, "8.28.0");
      const report = args[args.indexOf("--report-path") + 1];
      writeFileSync(report, JSON.stringify([
        { File: "src/a.ts", StartLine: 7, RuleID: "generic-api-key", Commit: "1234567890abcdef", Secret: "do-not-print" },
        { File: "src/fixture.ts", StartLine: 1, RuleID: "fixture", Match: "x gitleaks:allow scanner fixture" },
        { File: "src/no-reason.ts", StartLine: 1, RuleID: "fixture", Match: "x gitleaks:allow" },
      ]));
      return result(1);
    });
    const o = options(repo);
    const check = gitleaksCheck(o, deps);
    expect([check.findings.length, check.findings[0]?.rule, JSON.stringify(check).includes("do-not-print")]).toEqual([2, "secret/gitleaks", false]);
    expect(check.notices).toContain("note: bypass secret/gitleaks inline scanner fixture");
    expect(existsSync(join(o.out, "gitleaks.json"))).toBe(false);
    expect(scanArgsOf(deps, o)).toContain("--redact");
  });

  test("redacts secrets from scanner errors", () => {
    const repo = tmp();
    const token = "sk-proj-fixture0000000000000000000000";
    const deps = fake((_cmd, args) => args[0] === "version" ? result(0, "8.28.0") : result(2, "", `cannot scan token=${token}`));
    const error = gitleaksCheck(options(repo), deps).error;
    expect([error.includes(token), error.includes("[REDACTED]")]).toEqual([false, true]);
  });

  test("qg:allow requires a reason and records an inline bypass", () => {
    const o = options(tmp());
    const token = "sk-proj-fixture0000000000000000000000";
    const withReason = secretCheck(o, added("src/fixture.ts", `${token} // qg:allow scanner fixture`));
    expect([withReason.findings.length, withReason.notices]).toEqual([0, ["note: bypass secret/token inline scanner fixture"]]);
    expect(secretCheck(o, added("src/fixture.ts", `${token} // qg:allow`)).findings[0].rule).toBe("secret/token");
  });
});

function scanArgsOf(deps: SecurityDeps, o: Opts) {
  let args: string[] = [];
  const wrapped = fake((cmd, next) => {
    const r = deps.run(cmd, next, o.repo);
    if (next[0] !== "version") args = next;
    return r;
  });
  gitleaksCheck(o, wrapped);
  return args;
}

describe("deps/lock-age", () => {
  const lock = (version: string) => `{
  "lockfileVersion": 1,
  "packages": {
    "left-pad": ["left-pad@${version}", "", {}],
  },
}`;

  const npmAnswer = (version: string, date: string) => JSON.stringify({ time: { [version]: date } });

  test("accepts an old changed lock entry and reuses pkg-age.json without a registry call", () => {
    const repo = tmp();
    const text = lock("1.3.0");
    writeFileSync(join(repo, "bun.lock"), text);
    let calls = 0;
    const deps = fake(() => {
      calls++;
      return result(0, npmAnswer("1.3.0", "2020-01-01T00:00:00.000Z"));
    });
    const o = options(repo);
    expect(lockAgeCheck(o, added("bun.lock", text), deps).findings).toEqual([]);
    const noRegistry = fake(() => {
      throw new Error("registry must not be called for a warm cache");
    });
    expect([calls, lockAgeCheck(o, added("bun.lock", text), noRegistry).findings]).toEqual([1, []]);
    expect(JSON.parse(readFileSync(join(o.out, "pkg-age.json"), "utf8")).published["npm:left-pad@1.3.0"]).toBeTruthy();
    const offlineRepo = tmp();
    writeFileSync(join(offlineRepo, "bun.lock"), text);
    const offline = fake(() => result(1, "", "network offline"));
    expect(lockAgeCheck(options(offlineRepo), added("bun.lock", text), offline).notices).toEqual(["deps/lock-age: not checked (offline)"]);
  });

  test("blocks a version published inside the minimum age", () => {
    const repo = tmp();
    const text = lock("2.0.0");
    writeFileSync(join(repo, "bun.lock"), text);
    const now = Date.UTC(2026, 8, 21, 12);
    const deps = fake(() => result(0, npmAnswer("2.0.0", new Date(now - 2 * 3_600_000).toISOString())), now);
    const finding = lockAgeCheck(options(repo), added("bun.lock", text), deps).findings[0];
    expect(finding.msg).toBe("left-pad@2.0.0 published 2 hours ago; Bun minimumReleaseAge does not apply to locked versions (oven-sh/bun#30525)");
  });

  test("keeps the npm version when workspace package entries follow it", () => {
    const repo = tmp();
    const text = `{
  "lockfileVersion": 3,
  "packages": {
    "node_modules/zod-to-json-schema": {
      "version": "3.25.2",
      "resolved": "https://registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz",
      "integrity": "sha512-fixture"
    },
    "packages/context-window": {
      "name": "@acme/context-window",
      "version": "0.0.0"
    }
  }
}`;
    writeFileSync(join(repo, "package-lock.json"), text);
    let request: string[] = [];
    const deps = fake((cmd, args) => {
      request = [cmd, args.at(-1) ?? ""];
      return result(0, npmAnswer("3.25.2", "2020-01-01T00:00:00.000Z"));
    });
    expect(lockAgeCheck(options(repo), added("package-lock.json", text), deps).error).toBe("");
    expect(request).toEqual(["curl", "https://registry.npmjs.org/zod-to-json-schema"]);
  });

  test("[security] registry_urls sends the lookup to a mirror", () => {
    const repo = tmp();
    const text = lock("1.3.0");
    writeFileSync(join(repo, "bun.lock"), text);
    const o = options(repo);
    o.toml.security.registry_urls = { npm: "https://mirror.local/npm/{name}" };
    const urls: string[] = [];
    const deps = fake((_cmd, args) => {
      urls.push(args.at(-1) ?? "");
      return result(0, npmAnswer("1.3.0", "2020-01-01T00:00:00.000Z"));
    });
    expect(lockAgeCheck(o, added("bun.lock", text), deps).findings).toEqual([]);
    expect(urls).toEqual(["https://mirror.local/npm/left-pad"]);
  });

  test("an ecosystem without a registry is a notice, never a block", () => {
    const repo = tmp();
    const text = lock("1.3.0");
    writeFileSync(join(repo, "bun.lock"), text);
    const o = options(repo);
    o.toml.security.registry_urls = { npm: "" };
    const deps = fake(() => {
      throw new Error("no registry must mean no call");
    });
    const check = lockAgeCheck(o, added("bun.lock", text), deps);
    expect([check.findings, check.error, check.notices]).toEqual([[], "", ["deps/lock-age: not checked (no registry for npm)"]]);
  });

  test("skips uv virtual packages and queries only registry-backed entries", () => {
    const repo = tmp();
    const text = `version = 1

[[package]]
name = "qa-local-project"
version = "0.1.0"
source = { virtual = "." }

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }
`;
    writeFileSync(join(repo, "uv.lock"), text);
    const urls: string[] = [];
    const deps = fake((_cmd, args) => {
      urls.push(args.at(-1) ?? "");
      return result(0, JSON.stringify({ urls: [{ upload_time_iso_8601: "2020-01-01T00:00:00.000Z" }] }));
    });
    expect(lockAgeCheck(options(repo), added("uv.lock", text), deps).error).toBe("");
    expect(urls).toEqual(["https://pypi.org/pypi/requests/2.32.3/json"]);
  });
});

describe("deps/new-package", () => {
  const repoWithManifest = () => {
    const repo = tmp();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { kept: "1.0.0" } }, null, 2));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["add", "package.json"], { cwd: repo });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
    return repo;
  };

  test("does not note a range change for an existing direct dependency", () => {
    const repo = repoWithManifest();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { kept: "2.0.0" } }, null, 2));
    const o = buildOpts(readArgs(["--repo", repo, "--base", "HEAD"]));
    expect(newPackageCheck(o, changes(o)).notices).toEqual([]);
  });

  test("notes a new direct dependency with the qg:dep expectation", () => {
    const repo = repoWithManifest();
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { kept: "1.0.0", fresh: "^2.0.0" } }, null, 2));
    const o = buildOpts(readArgs(["--repo", repo, "--base", "HEAD"]));
    expect(newPackageCheck(o, changes(o)).notices).toEqual(["note: deps/new-package fresh@^2.0.0; expect qg:dep fresh <why> in the report"]);
  });
});

describe("deps/audit", () => {
  const auditRepo = () => {
    const repo = tmp();
    writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
    return repo;
  };

  test("accepts a clean npm audit and reuses audit.json by lock hash", () => {
    const o = options(auditRepo());
    let calls = 0;
    const deps = fake(() => {
      calls++;
      return result(0, JSON.stringify({ metadata: { vulnerabilities: { high: 0, critical: 0 } } }));
    });
    expect(auditCheck(o, deps).findings).toEqual([]);
    expect(auditCheck(o, fake(() => {
      throw new Error("audit must not run for a warm cache");
    })).findings).toEqual([]);
    expect([calls, JSON.parse(readFileSync(join(o.out, "audit.json"), "utf8")).lock]).toEqual([1, "package-lock.json"]);
    const offline = auditCheck(options(auditRepo()), fake(() => result(1, "", "network offline")));
    expect(offline.notices).toEqual(["deps/audit: not checked (offline)"]);
  });

  test("blocks a high vulnerability from npm audit JSON", () => {
    const o = options(auditRepo());
    const body = { vulnerabilities: { lodash: { name: "lodash", severity: "high", via: [{ source: 123, title: "prototype pollution", severity: "high" }] } } };
    const check = auditCheck(o, fake(() => result(1, JSON.stringify(body))));
    expect(check.findings.some((finding) => finding.rule === "deps/audit" && finding.msg.includes("(high)"))).toBe(true);
  });

  test("does not classify advisory stdout as offline and blocks unreadable audit output", () => {
    const advisory = { vulnerabilities: { net: { name: "net", severity: "high", via: [{ source: 1, title: "network exposure", severity: "high" }] } } };
    const found = auditCheck(options(auditRepo()), fake(() => result(1, JSON.stringify(advisory))));
    expect([found.findings.length, found.notices]).toEqual([1, []]);

    const unreadable = auditCheck(options(auditRepo()), fake(() => result(1, "not-json", "")));
    expect([unreadable.notices, unreadable.error.includes("audit output unreadable")]).toEqual([[], true]);
    const offline = auditCheck(options(auditRepo()), fake(() => result(1, "", "connect ECONNREFUSED 127.0.0.1")));
    expect(offline.notices).toEqual(["deps/audit: not checked (offline)"]);
  });
});
