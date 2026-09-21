// Every external tool the gate runs, in one place: the pinned version, the binary name and the
// install hint per platform. No version literal and no install hint lives outside this file.
// `[tools]` in .quality.toml overrides one entry: a bare value is a version (`jscpd = "5.3.0"`),
// a value with a path separator is a binary path (`gitleaks = "/opt/bin/gitleaks"`).
import { homedir } from "node:os";

export type Platform = NodeJS.Platform;
export type Install = { darwin: string; linux: string; win32?: string };
// npm = pinned npm package run through npx or installed into the tool cache; pypi = pinned package
// run through uv; binary = a command looked up on PATH.
export type Tool = { id: string; npm?: string; pypi?: string; binary?: string; install: Install };
export type ToolOverrides = Record<string, string>;

const everywhere = (hint: string): Install => ({ darwin: hint, linux: hint, win32: hint });
const npmTool = (id: string, version: string, install = everywhere(`npm install -D ${id}`)): Tool => ({ id, npm: `${id}@${version}`, install });

const NODE = everywhere("install Node.js or Bun");
const GO_INSTALL = (module: string) => everywhere(`go install ${module}`);

export const TOOLS: Record<string, Tool> = {
  // npm packages the gate installs into its cache or runs through npx
  "dependency-cruiser": npmTool("dependency-cruiser", "18.3.1"),
  typescript: npmTool("typescript", "5.9.3"),
  knip: npmTool("knip", "6.36.0"),
  jscpd: { id: "jscpd", npm: "jscpd@5.2.1", install: everywhere("install Node.js, then npm install -g jscpd@5.2.1") },
  eslint: npmTool("eslint", "10.8.0"),
  "typescript-eslint-parser": { id: "typescript-eslint-parser", npm: "@typescript-eslint/parser@8.66.0", install: everywhere("npm install -D @typescript-eslint/parser") },
  "eslint-plugin-sonarjs": npmTool("eslint-plugin-sonarjs", "4.2.1"),
  "ast-grep": { id: "ast-grep", npm: "@ast-grep/cli@0.45.3", binary: "ast-grep", install: everywhere("npm install -g @ast-grep/cli@0.45.3") },
  // pinned Python tools, run through uv
  lizard: { id: "lizard", pypi: "lizard==1.24.0", binary: "lizard", install: everywhere("install uv (astral.sh/uv)") },
  radon: { id: "radon", pypi: "radon==6.0.1", binary: "radon", install: everywhere("install uv (astral.sh/uv)") },
  // binaries the gate calls directly
  gitleaks: { id: "gitleaks", binary: "gitleaks", install: { darwin: "brew install gitleaks", linux: "download the release from https://github.com/gitleaks/gitleaks/releases", win32: "winget install gitleaks" } },
  "osv-scanner": { id: "osv-scanner", binary: "osv-scanner", install: { darwin: "brew install osv-scanner", linux: "go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest" } },
  semgrep: { id: "semgrep", binary: "semgrep", install: everywhere("pipx install semgrep") },
  // tools the language adapters run
  node: { id: "node", binary: "node", install: NODE },
  go: { id: "go", binary: "go", install: { darwin: "brew install go", linux: "install Go from https://go.dev/dl", win32: "winget install GoLang.Go" } },
  gcov2lcov: { id: "gcov2lcov", binary: "gcov2lcov", install: GO_INSTALL("github.com/jandelgado/gcov2lcov@latest") },
  deadcode: { id: "deadcode", binary: "deadcode", install: GO_INSTALL("golang.org/x/tools/cmd/deadcode@latest") },
  gocyclo: { id: "gocyclo", binary: "gocyclo", install: GO_INSTALL("github.com/fzipp/gocyclo/cmd/gocyclo@latest") },
  pmd: { id: "pmd", binary: "pmd", install: { darwin: "brew install pmd", linux: "download the release from https://pmd.github.io", win32: "download the release from https://pmd.github.io" } },
  detekt: { id: "detekt", binary: "detekt", install: { darwin: "brew install detekt", linux: "download the release from https://detekt.dev/docs/gettingstarted/cli" } },
  xccov2lcov: { id: "xccov2lcov", binary: "xccov2lcov", install: { darwin: "brew install xccov2lcov", linux: "not available: xccov needs Xcode" } },
  periphery: { id: "periphery", binary: "periphery", install: { darwin: "brew install peripheryapp/periphery/periphery", linux: "download the release from https://github.com/peripheryapp/periphery/releases" } },
  swiftlint: { id: "swiftlint", binary: "swiftlint", install: { darwin: "brew install swiftlint", linux: "download the release from https://github.com/realm/SwiftLint/releases" } },
  "include-what-you-use": { id: "include-what-you-use", binary: "include-what-you-use", install: { darwin: "brew install include-what-you-use", linux: "apt install iwyu" } },
  "clang-tidy": { id: "clang-tidy", binary: "clang-tidy", install: { darwin: "brew install llvm", linux: "apt install clang-tidy" } },
  reportgenerator: { id: "reportgenerator", binary: "reportgenerator", install: everywhere("dotnet tool install -g dotnet-reportgenerator-globaltool") },
};

export const TOOL_IDS = Object.keys(TOOLS);

export function toolOf(id: string): Tool {
  const tool = TOOLS[id];
  if (!tool) throw new Error(`unknown tool ${id}; expected ${TOOL_IDS.join(", ")}`);
  return tool;
}

// A config error, not a crash: the key the user wrote is named back.
export function validateToolOverrides(value: unknown, file: string) {
  if (!value || typeof value !== "object") return;
  const bad = Object.keys(value as object).filter((id) => !TOOLS[id]);
  if (bad.length) throw new Error(`${file}: unknown tool id(s) in [tools]: ${bad.join(", ")}`);
}

const isPath = (value: string) => value.includes("/") || value.includes("\\");
const override = (id: string, overrides: ToolOverrides) => String(overrides[id] ?? "").trim();

function pinned(spec: string, id: string, separator: string, overrides: ToolOverrides) {
  const value = override(id, overrides);
  const name = spec.slice(0, spec.lastIndexOf(separator));
  return value && !isPath(value) ? `${name}${separator}${value}` : spec;
}

export function npmSpec(id: string, overrides: ToolOverrides = {}) {
  const tool = toolOf(id);
  if (!tool.npm) throw new Error(`tool ${id} has no npm package`);
  return pinned(tool.npm, id, "@", overrides);
}

export function packageSpec(id: string, overrides: ToolOverrides = {}) {
  const tool = toolOf(id);
  if (!tool.pypi) throw new Error(`tool ${id} has no Python package`);
  return pinned(tool.pypi, id, "==", overrides);
}

// The version part of a pinned spec, for the messages that name it ("ast-grep 0.45.3").
export const pinnedVersion = (spec: string, separator = "@") => spec.slice(spec.lastIndexOf(separator) + separator.length);

export function toolBinary(id: string, overrides: ToolOverrides = {}) {
  const tool = toolOf(id);
  const value = override(id, overrides);
  if (value && isPath(value)) return value;
  return tool.binary ?? id;
}

export function installHint(id: string, overrides: ToolOverrides = {}, platform: Platform = process.platform) {
  const install = toolOf(id).install;
  const hint = platform === "darwin" ? install.darwin : platform === "win32" ? (install.win32 ?? install.linux) : install.linux;
  const value = override(id, overrides);
  return value && isPath(value) ? `${hint} (or set [tools] ${id})` : hint;
}

// Cache for the npm tools the gate installs itself: QG_TOOLS, else [project] tools_dir, else the
// platform default.
export function toolsDir(configured = "", env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform) {
  const fromEnv = (env.QG_TOOLS ?? "").trim();
  if (fromEnv) return fromEnv;
  if (configured.trim()) return configured.trim();
  if (platform === "win32") return `${env.LOCALAPPDATA ?? homedir()}/quality-gate`;
  return `${env.HOME || homedir()}/.cache/quality-gate`;
}
