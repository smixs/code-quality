// Language adapters are data. Detection may return several roots for one repository; callers route
// each file to the deepest matching root instead of assigning one language to the whole repository.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { installHint } from "./tools.ts";

export type LanguageId = "ts" | "py" | "go" | "rust" | "java" | "kotlin" | "csharp" | "swift" | "php" | "ruby" | "cpp" | "dart";
export type ToolAdapter = { tool: string; command: string; install: string; format: string };
export type TestPatterns = { test: string[]; assert: string[]; skip: string[]; only: string[]; mock: string[] };
export type LanguageAdapter = {
  id: LanguageId;
  name: string;
  detect: string[];
  extensions: string[];
  lizardLang: string | null;
  // The pre-push command for the touched test files; "" = no file-level runner, DEFAULT_PRE_PUSH runs.
  prePushTest: string;
  testGlobs: string[];
  testPatterns: TestPatterns;
  coverage: ToolAdapter;
  cycles: ToolAdapter;
  dead: ToolAdapter;
  form: ToolAdapter;
  audit: ToolAdapter & { fallback?: string };
  depAge: { provider: "deps.dev" | "ecosyste.ms"; ecosystem: string; registry?: string };
};
export type LanguageRoot = { adapter: LanguageAdapter; root: string };

const tool = (name: string, command: string, install: string, format = "json"): ToolAdapter => ({ tool: name, command, install, format });

// Every default test command lives here; no runner name is written anywhere else.
const DEFAULT_PRE_PUSH = "node --test {files}";
const PY_PRE_PUSH = 'uv run --with pytest pytest -q {files}';
const NODE_TEST_COVERAGE = "node --test --experimental-test-coverage --test-coverage-exclude='**/*.test.*' --test-reporter=lcov --test-reporter-destination=\"$QG_LCOV\" --test-reporter=spec --test-reporter-destination=stdout";
const BUN_TEST_COVERAGE = 'bun test scripts/ --coverage --coverage-reporter=lcov --coverage-dir="$QG_DIR/bun" && cp "$QG_DIR/bun/lcov.info" "$QG_LCOV"';
const VITEST_COVERAGE = 'npx vitest run --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov --coverage.reportsDirectory="$QG_DIR/vitest" && cp "$QG_DIR/vitest/lcov.info" "$QG_LCOV"';
const PY_TEST_COVERAGE = 'uv run --with pytest-cov pytest -q --cov=. --cov-report=lcov:"$QG_LCOV"';

export const prePushTestCommand = (adapter?: LanguageAdapter) => adapter?.prePushTest || DEFAULT_PRE_PUSH;

// The full gate's default coverage command: the repo's own runner decides, not the caller.
export function defaultTestCommand(repo: string, lang: string, readPackage: (path: string) => string) {
  if (lang === "py") return PY_TEST_COVERAGE;
  const pkg = readPackage(join(repo, "package.json"));
  if (!pkg) return BUN_TEST_COVERAGE;
  return pkg.includes('"vitest"') ? VITEST_COVERAGE : NODE_TEST_COVERAGE;
}
const osv = (fallback?: string) => ({ ...tool("osv-scanner", "osv-scanner scan source --format json .", installHint("osv-scanner")), fallback });
const patterns = (test: string[], assert: string[], ...flags: [string[], string[], string[]]): TestPatterns => ({
  test, assert, skip: flags[0], only: flags[1], mock: flags[2],
});

const JS_TEST = patterns(
  ["\\b(?:it|test|describe)\\s*\\("],
  ["\\bexpect\\s*\\(", "\\bassert(?:\\.[A-Za-z]+)?\\s*\\("],
  ["\\.(?:skip|todo)\\s*\\(", "\\b(?:xit|xdescribe)\\s*\\("],
  ["\\.only\\s*\\("],
  ["\\b(?:vi|jest)\\.mock\\s*\\(", "\\bmock\\.module\\s*\\("],
);
const PY_TEST = patterns(
  ["^\\s*def\\s+test_", "^\\s*class\\s+Test"],
  ["\\bassert\\s+", "\\bself\\.assert[A-Z]"],
  ["@pytest\\.mark\\.(?:skip|xfail)", "\\bpytest\\.skip\\s*\\(", "@unittest\\.skip"],
  [],
  ["\\bmonkeypatch\\b", "@patch\\s*\\(", "\\bmocker\\.patch\\s*\\("],
);

export const ADAPTERS: LanguageAdapter[] = [
  {
    id: "ts", name: "TypeScript/JavaScript", detect: ["package.json"], extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], lizardLang: "typescript", prePushTest: DEFAULT_PRE_PUSH,
    testGlobs: ["**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "**/*.spec.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], testPatterns: JS_TEST,
    coverage: tool("native JS test runner", "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=\"$QG_LCOV\"", installHint("node"), "lcov"),
    cycles: tool("dependency-cruiser", "npx dependency-cruiser --output-type json .", "npm install -D dependency-cruiser"),
    dead: tool("knip", "npx knip --reporter json --no-exit-code", "npm install -D knip"),
    form: tool("eslint", "npx eslint --format json .", "npm install -D eslint eslint-plugin-sonarjs"), audit: osv("npm audit --json / bun audit --json"),
    depAge: { provider: "deps.dev", ecosystem: "NPM" },
  },
  {
    id: "py", name: "Python", detect: ["pyproject.toml", "setup.py"], extensions: [".py"], lizardLang: "python", prePushTest: PY_PRE_PUSH,
    testGlobs: ["**/test_*.py", "**/*_test.py"], testPatterns: PY_TEST,
    coverage: tool("pytest-cov", "uv run --with pytest-cov pytest --cov=. --cov-report=lcov:\"$QG_LCOV\"", "uv add --dev pytest pytest-cov", "lcov"),
    cycles: tool("pycycle", "pycycle --here --format json", "uv tool install pycycle"), dead: tool("vulture", "uvx vulture .", "uv tool install vulture", "text"),
    form: tool("ruff/radon", "uvx ruff check --output-format json .", "uv tool install ruff && uv tool install radon"), audit: osv("uvx pip-audit -f json --locked ."),
    depAge: { provider: "deps.dev", ecosystem: "PYPI" },
  },
  {
    id: "go", name: "Go", detect: ["go.mod"], extensions: [".go"], lizardLang: "go", prePushTest: "",
    testGlobs: ["**/*_test.go"], testPatterns: patterns(["\\bfunc\\s+Test", "\\bt\\.Run\\s*\\("], ["\\b(?:assert|require)\\."], ["\\bt\\.Skip(?:f|Now)?\\s*\\("], [], ["\\bmock\\."]),
    coverage: tool("go test/gcov2lcov", "go test ./... -coverprofile=coverage.out && gcov2lcov -infile coverage.out -outfile \"$QG_LCOV\"", `${installHint("go")} && ${installHint("gcov2lcov")}`, "lcov"),
    cycles: tool("go list", "go list -json ./...", installHint("go")), dead: tool("deadcode", "deadcode -json ./...", installHint("deadcode")),
    form: tool("gocyclo", "gocyclo -over 10 .", installHint("gocyclo"), "text"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "GO" },
  },
  {
    id: "rust", name: "Rust", detect: ["Cargo.toml"], extensions: [".rs"], lizardLang: "rust", prePushTest: "",
    testGlobs: ["**/tests/**/*.rs", "**/*_test.rs"], testPatterns: patterns(["#\\[test\\]"], ["\\bassert(?:_eq|_ne)?!\\s*\\("], ["#\\[ignore"], [], ["\\bmockall\\b", "\\bmock!\\s*\\{"]),
    coverage: tool("cargo-llvm-cov", "cargo llvm-cov --lcov --output-path \"$QG_LCOV\"", "cargo install cargo-llvm-cov", "lcov"),
    cycles: tool("cargo-modules", "cargo modules dependencies --lib", "cargo install cargo-modules", "text"), dead: tool("cargo-machete", "cargo machete --json", "cargo install cargo-machete"),
    form: tool("cargo clippy", "cargo clippy --message-format=json", "rustup component add clippy", "jsonl"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "CARGO" },
  },
  {
    id: "java", name: "Java", detect: ["pom.xml", "build.gradle"], extensions: [".java"], lizardLang: "java", prePushTest: "",
    testGlobs: ["**/src/test/**/*.java", "**/*Test.java"], testPatterns: patterns(["@Test"], ["\\bassert[A-Z]\\w*\\s*\\("], ["@Disabled", "@Ignore"], [], ["\\bMockito\\.", "@Mock"]),
    coverage: tool("JaCoCo/ReportGenerator", "reportgenerator -reports:**/jacoco.xml -targetdir:$QG_DIR/jacoco -reporttypes:lcov", installHint("reportgenerator"), "lcov"),
    cycles: tool("jdeps", "jdeps -dotoutput $QG_DIR/jdeps -verbose:class .", "install JDK 21", "dot"), dead: tool("PMD", "pmd check -d . -R category/java/bestpractices.xml -f sarif", installHint("pmd"), "sarif"),
    form: tool("PMD", "pmd check -d . -R category/java/design.xml -f sarif", installHint("pmd"), "sarif"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "MAVEN" },
  },
  {
    id: "kotlin", name: "Kotlin", detect: ["build.gradle.kts"], extensions: [".kt", ".kts"], lizardLang: "kotlin", prePushTest: "",
    testGlobs: ["**/src/test/**/*.kt", "**/*Test.kt"], testPatterns: patterns(["@Test"], ["\\bassert[A-Z]\\w*\\s*\\("], ["@Disabled", "@Ignore"], [], ["\\bmockk\\s*\\(", "@MockK"]),
    coverage: tool("JaCoCo/ReportGenerator", "reportgenerator -reports:**/jacoco.xml -targetdir:$QG_DIR/jacoco -reporttypes:lcov", installHint("reportgenerator"), "lcov"),
    cycles: tool("Konsist", "./gradlew konsistTest", "add Konsist or ArchUnit tests", "text"), dead: tool("detekt", "detekt --report sarif:$QG_DIR/detekt.sarif", installHint("detekt"), "sarif"),
    form: tool("detekt", "detekt --report sarif:$QG_DIR/detekt.sarif", installHint("detekt"), "sarif"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "MAVEN" },
  },
  {
    id: "csharp", name: "C#", detect: ["*.csproj", "*.sln"], extensions: [".cs"], lizardLang: "csharp", prePushTest: "",
    testGlobs: ["**/*Tests.cs", "**/*Test.cs"], testPatterns: patterns(["\\[(?:Fact|Theory|Test)\\]"], ["\\bAssert\\."], ["\\bSkip\\s*=", "\\[Ignore"], [], ["\\bMock<", "\\bSubstitute\\."]),
    coverage: tool("Coverlet", "dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=lcov", "dotnet add package coverlet.msbuild", "lcov"),
    cycles: tool("Roslyn analyzers", "dotnet build", "install .NET SDK and architecture analyzers", "sarif"), dead: tool("Roslyn analyzers", "dotnet build /p:ErrorLog=$QG_DIR/roslyn.sarif", "install .NET SDK", "sarif"),
    form: tool("Roslyn analyzers", "dotnet build /p:ErrorLog=$QG_DIR/roslyn.sarif", "install .NET SDK", "sarif"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "NUGET" },
  },
  {
    id: "swift", name: "Swift", detect: ["Package.swift"], extensions: [".swift"], lizardLang: "swift", prePushTest: "",
    testGlobs: ["**/Tests/**/*.swift", "**/*Tests.swift"], testPatterns: patterns(["\\bfunc\\s+test"], ["\\bXCTAssert"], ["\\bXCTSkip"], [], ["\\bMock\\w+"]),
    coverage: tool("xccov2lcov", "xcrun xccov view --report --json .build/*.xcresult | xccov2lcov > \"$QG_LCOV\"", installHint("xccov2lcov"), "lcov"),
    cycles: tool("swift package", "swift package show-dependencies --format json", "install Xcode command-line tools"), dead: tool("periphery", "periphery scan --format json", installHint("periphery")),
    form: tool("SwiftLint", "swiftlint lint --reporter json", installHint("swiftlint")), audit: osv(), depAge: { provider: "ecosyste.ms", ecosystem: "swiftpm", registry: "swift" },
  },
  {
    id: "php", name: "PHP", detect: ["composer.json"], extensions: [".php"], lizardLang: "php", prePushTest: "",
    testGlobs: ["**/tests/**/*.php", "**/*Test.php"], testPatterns: patterns(["\\bfunction\\s+test"], ["\\$this->assert", "\\bself::assert"], ["markTestSkipped\\s*\\("], [], ["createMock\\s*\\(", "\\bMockery::"]),
    coverage: tool("PHPUnit Clover/ReportGenerator", "reportgenerator -reports:clover.xml -targetdir:$QG_DIR/php -reporttypes:lcov", `composer require --dev phpunit/phpunit && ${installHint("reportgenerator")}`, "lcov"),
    cycles: tool("deptrac", "vendor/bin/deptrac analyse --formatter=json", "composer require --dev qossmic/deptrac-shim"), dead: tool("PHPStan", "vendor/bin/phpstan analyse --error-format=json", "composer require --dev phpstan/phpstan"),
    form: tool("PHPMD", "phpmd . json cleancode,codesize", "composer require --dev phpmd/phpmd"), audit: osv(), depAge: { provider: "ecosyste.ms", ecosystem: "composer", registry: "packagist" },
  },
  {
    id: "ruby", name: "Ruby", detect: ["Gemfile"], extensions: [".rb"], lizardLang: "ruby", prePushTest: "",
    testGlobs: ["**/spec/**/*_spec.rb", "**/test/**/*_test.rb"], testPatterns: patterns(["\\bit\\s*(?:\\(|[\"'])", "\\btest\\s+[\"']"], ["\\bexpect\\s*\\(", "\\bassert"], ["\\bskip\\b", "xit\\s*\\("], ["fit\\s*\\(", "focus:\\s*true"], ["allow\\s*\\(", "instance_double\\s*\\("]),
    coverage: tool("simplecov-lcov", "bundle exec ruby -Itest && cp coverage/lcov/*.lcov \"$QG_LCOV\"", "bundle add simplecov-lcov --group test", "lcov"),
    cycles: tool("Packwerk", "bundle exec packwerk check", "bundle add packwerk --group development", "text"), dead: tool("RuboCop", "bundle exec rubocop --format json", "bundle add rubocop --group development,test"),
    form: tool("RuboCop", "bundle exec rubocop --format json", "bundle add rubocop --group development,test"), audit: osv(), depAge: { provider: "deps.dev", ecosystem: "RUBYGEMS" },
  },
  {
    id: "cpp", name: "C/C++", detect: ["CMakeLists.txt", "Makefile"], extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"], lizardLang: "cpp", prePushTest: "",
    testGlobs: ["**/test/**/*.{c,cc,cpp,cxx}", "**/*_test.{c,cc,cpp,cxx}"], testPatterns: patterns(["\\bTEST(?:_F|_P)?\\s*\\("], ["\\b(?:EXPECT|ASSERT)_"], ["\\bGTEST_SKIP\\s*\\("], ["DISABLED_"], ["\\bMOCK_METHOD\\s*\\("]),
    coverage: tool("gcov/ReportGenerator", "reportgenerator -reports:**/*.gcov.xml -targetdir:$QG_DIR/cpp -reporttypes:lcov", installHint("reportgenerator"), "lcov"),
    cycles: tool("include-what-you-use", "include-what-you-use .", installHint("include-what-you-use"), "text"), dead: tool("clang-tidy", "clang-tidy -checks=misc-unused-*", installHint("clang-tidy"), "yaml"),
    form: tool("clang-tidy", "clang-tidy -checks=readability-function-cognitive-complexity", installHint("clang-tidy"), "yaml"), audit: osv(), depAge: { provider: "ecosyste.ms", ecosystem: "conan", registry: "conan-center" },
  },
  {
    id: "dart", name: "Dart", detect: ["pubspec.yaml"], extensions: [".dart"], lizardLang: null, prePushTest: "",
    testGlobs: ["**/test/**/*_test.dart"], testPatterns: patterns(["\\btest\\s*\\("], ["\\bexpect\\s*\\("], ["skip\\s*:"], ["solo_test\\s*\\("], ["registerFallbackValue\\s*\\(", "when\\s*\\("]),
    coverage: tool("coverage:format_coverage", "dart test --coverage=$QG_DIR/dart && format_coverage --lcov --in=$QG_DIR/dart --out=\"$QG_LCOV\" --packages=.dart_tool/package_config.json --report-on=lib", "dart pub global activate coverage", "lcov"),
    cycles: tool("dart analyze", "dart analyze --format=json", "install Dart SDK", "json"), dead: tool("dart analyze", "dart analyze --format=json", "install Dart SDK", "json"),
    form: tool("dart_code_metrics", "dart run dart_code_metrics:metrics analyze lib --reporter=json", "dart pub add --dev dart_code_metrics", "json"), audit: osv(), depAge: { provider: "ecosyste.ms", ecosystem: "pub", registry: "pub.dev" },
  },
];

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));
const IGNORED_DIRS = new Set([".git", ".scratch", "node_modules", "vendor", "dist", "build", ".venv", "target"]);

function filesUnder(repo: string) {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const file = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) visit(file);
      else if (entry.isFile()) out.push(file);
    }
  };
  visit(".");
  return out;
}

function detectMatch(adapter: LanguageAdapter, file: string) {
  return adapter.detect.some((pattern) => pattern.includes("*") ? new Bun.Glob(pattern).match(basename(file)) : basename(file) === pattern);
}

function selectedIds(selected: string | string[]) {
  const values = (Array.isArray(selected) ? selected : selected ? [selected] : []).map(String) as LanguageId[];
  for (const id of values) if (!BY_ID.has(id)) throw new Error(`unknown project.language ${id}; expected ${ADAPTERS.map((item) => item.id).join(", ")}`);
  return new Set(values);
}

function manifestRoots(files: string[], picked: Set<LanguageId>) {
  const out: LanguageRoot[] = [];
  for (const adapter of ADAPTERS) {
    if (picked.size && !picked.has(adapter.id)) continue;
    for (const file of files.filter((name) => detectMatch(adapter, name))) out.push({ adapter, root: dirname(file) });
  }
  return out;
}

function hasExtension(files: string[], root: string, adapter: LanguageAdapter) {
  const prefix = root === "." ? "" : `${root}/`;
  return files.some((file) => file.startsWith(prefix) && adapter.extensions.some((ext) => file.endsWith(ext)));
}

function pruneAmbiguous(roots: LanguageRoot[], files: string[]) {
  return roots.filter((item) => {
    if (item.adapter.id === "cpp" && basename(findManifest(item, files)) === "Makefile") return hasExtension(files, item.root, item.adapter);
    if (item.adapter.id === "java" && roots.some((other) => other.root === item.root && other.adapter.id === "kotlin")) return hasExtension(files, item.root, item.adapter);
    return true;
  });
}

function findManifest(item: LanguageRoot, files: string[]) {
  return files.find((file) => dirname(file) === item.root && detectMatch(item.adapter, file)) ?? "";
}

function dedupeRoots(roots: LanguageRoot[]) {
  const unique = new Map(roots.map((item) => [`${item.adapter.id}:${item.root}`, item]));
  return [...unique.values()].sort((a, b) => rootOrder(a.root, b.root) || ADAPTERS.indexOf(a.adapter) - ADAPTERS.indexOf(b.adapter));
}

function rootOrder(a: string, b: string) {
  if (a === b) return 0;
  if (a === ".") return -1;
  if (b === ".") return 1;
  return a.localeCompare(b);
}

function inferredRoots(files: string[], picked: Set<LanguageId>, detected: LanguageRoot[]) {
  const candidates = ADAPTERS.filter((adapter) => !picked.size || picked.has(adapter.id));
  return candidates.filter((adapter) => hasUncoveredSource(files, adapter, detected)).map((adapter) => ({ adapter, root: "." }));
}

function hasUncoveredSource(files: string[], adapter: LanguageAdapter, detected: LanguageRoot[]) {
  const roots = detected.filter((item) => item.adapter.id === adapter.id);
  return files.some((file) => adapter.extensions.some((ext) => file.endsWith(ext)) && !roots.some((item) => inRoot(item.root, file)));
}

export function detectLanguageRoots(repo: string, selected: string | string[]): LanguageRoot[] {
  if (!existsSync(repo)) return [];
  const files = filesUnder(repo);
  const picked = selectedIds(selected);
  const detected = dedupeRoots(pruneAmbiguous(manifestRoots(files, picked), files));
  const inferred = inferredRoots(files, picked, detected);
  if (detected.length || inferred.length) return dedupeRoots([...detected, ...inferred]);
  return picked.size ? [...picked].map((id) => ({ adapter: BY_ID.get(id)!, root: "." })) : [];
}

function inRoot(root: string, file: string) {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

export function adapterForFile(roots: LanguageRoot[], file: string) {
  const matches = roots.filter((item) => inRoot(item.root, file) && item.adapter.extensions.some((ext) => file.endsWith(ext)));
  return matches.sort((a, b) => b.root.length - a.root.length)[0]?.adapter;
}

export function rootForFile(roots: LanguageRoot[], file: string) {
  return roots.filter((item) => inRoot(item.root, file) && item.adapter.extensions.some((ext) => file.endsWith(ext))).sort((a, b) => b.root.length - a.root.length)[0];
}

export const adapterById = (id: string) => BY_ID.get(id as LanguageId);

function pathInRoot(root: string, file: string) {
  return root === "." ? file : file.slice(root.length + 1);
}

function globMatches(glob: string, file: string) {
  if (new Bun.Glob(glob).match(file)) return true;
  return glob.startsWith("**/") && new Bun.Glob(glob.slice(3)).match(file);
}

export function isTestFile(roots: LanguageRoot[], file: string) {
  const item = rootForFile(roots, file);
  if (!item) return false;
  const local = pathInRoot(item.root, file);
  return item.adapter.testGlobs.some((glob) => globMatches(glob, local));
}

export function matchesTestPattern(adapter: LanguageAdapter, kind: keyof TestPatterns, text: string) {
  return adapter.testPatterns[kind].some((source) => new RegExp(source, "m").test(text));
}

export function siblingTestFiles(roots: LanguageRoot[], file: string) {
  const item = rootForFile(roots, file);
  if (!item) return [];
  const dot = file.lastIndexOf(".");
  const stem = dot < 0 ? file : file.slice(0, dot);
  const ext = dot < 0 ? "" : file.slice(dot);
  return siblingNames(item.adapter.id, stem, ext);
}

function siblingNames(id: LanguageId, stem: string, ext: string) {
  return SIBLING_NAMES[id](stem, ext);
}

const xunitNames = (stem: string, ext: string) => [`${stem}Test${ext}`, `${stem}Tests${ext}`];
const SIBLING_NAMES: Record<LanguageId, (stem: string, ext: string) => string[]> = {
  ts: (stem, ext) => [`${stem}.test${ext}`, `${stem}.spec${ext}`],
  py: (stem) => [join(dirname(stem), `test_${basename(stem)}.py`), join("tests", `test_${basename(stem)}.py`)],
  go: (stem) => [`${stem}_test.go`],
  rust: (stem) => [`${stem}_test.rs`, join(dirname(stem), "tests", `${basename(stem)}.rs`), join("tests", `${basename(stem)}.rs`)],
  java: xunitNames, kotlin: xunitNames, csharp: xunitNames, swift: xunitNames, php: xunitNames,
  ruby: (stem) => [`${stem}_test.rb`, `${stem}_spec.rb`],
  cpp: (stem, ext) => [`${stem}_test${ext}`], dart: (stem, ext) => [`${stem}_test${ext}`],
};
