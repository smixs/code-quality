# Languages

Autodetection looks for manifests in every subfolder, so one monorepo can hold several `(language, root)` pairs. A changed file is routed to the deepest matching root.

Lizard and lcov cover every language, so complexity and coverage use the same bar everywhere. Cycles, dead code and form come from the adapter installed for that stack. A missing adapter is one `not run` line, never a silent pass.

| language | autodetect | blocks | not run until installed |
|---|---|---|---|
| TypeScript/JavaScript | `package.json` | ESLint CRAP, dependency-cruiser, knip, ESLint/SonarJS, OSV | Node.js; packages pinned into the gate cache |
| Python | `pyproject.toml`, `setup.py` | Radon CRAP, pycycle, vulture, Ruff, OSV | `uv tool install pycycle vulture ruff radon` |
| Go | `go.mod` | Lizard CRAP, `go list`, deadcode, gocyclo, OSV | `go install` for deadcode and gocyclo |
| Rust | `Cargo.toml` | Lizard CRAP, cargo-modules, cargo-machete, Clippy JSON, OSV | `cargo install cargo-modules cargo-machete`, `rustup component add clippy` |
| Java | `pom.xml`, `build.gradle` | Lizard CRAP, jdeps, PMD SARIF, OSV | JDK 21, `brew install pmd osv-scanner` |
| Kotlin | `build.gradle.kts` | Lizard CRAP, Konsist/ArchUnit, detekt SARIF, OSV | `brew install detekt osv-scanner` |
| C# | `*.csproj`, `*.sln` | Lizard CRAP, Roslyn SARIF, OSV | .NET SDK |
| Swift | `Package.swift` | Lizard CRAP, SwiftPM graph, Periphery, SwiftLint, OSV | Xcode CLI, `brew install periphery swiftlint` |
| PHP | `composer.json` | Lizard CRAP, deptrac, PHPStan, PHPMD, OSV | Composer packages of the adapter |
| Ruby | `Gemfile` | Lizard CRAP, Packwerk, RuboCop, OSV | gems `packwerk`, `rubocop` |
| C/C++ | `CMakeLists.txt`, `Makefile` | Lizard CRAP, IWYU, clang-tidy, OSV | `brew install include-what-you-use llvm` |
| Dart | `pubspec.yaml` | dart analyze, dart_code_metrics, OSV | Dart SDK; `crap/cc` does not run, Lizard has no Dart |
