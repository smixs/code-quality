# Languages and check availability

Autodetection looks for manifests in every subfolder. One monorepo can get several `(language, root)`
pairs. A changed file is routed to the deepest matching root. A language can be a string, a list, or
empty. A missing external tool always gives
`not run: <rule> (<tool> not found: <how to install>; roots: N)` in Markdown/JSON and does not change
the exit code. The same message for several roots is printed once with the total root count. This rule
holds in `check` and in the full gate.

For TS/JS, CC and function ranges come from the ESLint AST, for Python from Radon 6.0.1. When the
native analyzer is missing or failed to parse a file, the gate uses Lizard and writes
`crap: lizard fallback for <file>`. For the other languages Lizard 1.24.0 is the only source of CC.
Dart is not supported by Lizard, so `crap/cc` stays `not run`. In every language `dup/jscpd`, the
applicable `ast-grep` rules, the secret regexes, tamper, `cov/diff`, docs and glossary also block.
Semgrep only writes `security/semgrep` notes.

| language | autodetect | what really blocks | `not run` and what to install |
|---|---|---|---|
| TypeScript/JavaScript | `package.json` | ESLint CRAP, dependency-cruiser, knip, ESLint/SonarJS, OSV | `npx`/Node.js; packages are pinned and installed into the gate cache; `brew install osv-scanner` |
| Python | `pyproject.toml`, `setup.py` | Radon CRAP, pycycle, vulture, Ruff, OSV | `uv tool install pycycle vulture ruff radon`; `brew install osv-scanner` |
| Go | `go.mod` | Lizard CRAP, `go list`, deadcode, gocyclo, OSV | `brew install go osv-scanner`; then `go install` for deadcode/gocyclo |
| Rust | `Cargo.toml` | Lizard CRAP, cargo-modules, cargo-machete, Clippy JSON, OSV | Rust toolchain; `cargo install cargo-modules cargo-machete`; `rustup component add clippy`; `brew install osv-scanner` |
| Java | `pom.xml`, `build.gradle` | Lizard CRAP, jdeps, PMD SARIF, OSV | JDK 21; `brew install pmd osv-scanner` |
| Kotlin | `build.gradle.kts` | Lizard CRAP, Konsist/ArchUnit, detekt SARIF, OSV | add an architecture test; `brew install detekt osv-scanner` |
| C# | `*.csproj`, `*.sln` | Lizard CRAP, Roslyn SARIF, OSV | .NET SDK, analyzers in the project; `brew install osv-scanner` |
| Swift | `Package.swift` | Lizard CRAP, SwiftPM graph, Periphery, SwiftLint, OSV | Xcode CLI; `brew install peripheryapp/periphery/periphery swiftlint osv-scanner` |
| PHP | `composer.json` | Lizard CRAP, deptrac, PHPStan, PHPMD, OSV | the adapter's Composer packages; `brew install osv-scanner` |
| Ruby | `Gemfile` | Lizard CRAP, Packwerk, RuboCop, OSV | gems `packwerk`, `rubocop`; `brew install osv-scanner` |
| C/C++ | `CMakeLists.txt`, a `Makefile` with C/C++ files | Lizard CRAP, IWYU, clang-tidy, OSV | `brew install include-what-you-use llvm osv-scanner` |
| Dart | `pubspec.yaml` | dart analyze, dart_code_metrics, OSV; CRAP does not run yet | Dart SDK; `dart pub add --dev dart_code_metrics`; `brew install osv-scanner` |
