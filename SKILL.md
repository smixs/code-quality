---
name: code-quality
description: "Cross-language code quality pipeline for TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, Swift, PHP, Ruby, C/C++ and Dart: one bar for CRAP and complexity, adapters for cycles, dead code, form and audit, duplication, structural rules, tamper, diff coverage, doc links, glossary, secrets and AI attribution. git hooks and Stop adapters for Claude Code, Codex and pi call one script; repo setup is one .quality.toml. Use when - CRAP, complexity, code quality, quality gate, ratchet, baseline, hotspots, what to cover with tests, what to split, dead code, import cycles, wiring a repo into the gate, quality git hooks, .quality.toml, quality Stop hook. Not for running ordinary tests, lint or typecheck."
---

# code-quality

One bun script, no server: `~/.claude/skills/code-quality/scripts/quality.ts`. Every entry point
(git hooks, agent Stop adapters, manual runs) calls it and decides nothing on its own. Only the
deterministic part blocks. Jev writes `note: jev ...` lines and never changes the exit code (section
"Jev: test notes"); the LLM reviewer is not wired yet. The owner's decisions of 18.09.2026 (recorded
outside this repo) fix the bar and the rule that reviewers never block.

## Pipeline

| where | when | what | time on a mid-size TS repo |
|---|---|---|---|
| `pre-commit` | `git commit` | `check --staged`: tamper, coverage of added lines, complexity and CRAP of changed functions, deps, knip, eslint form, jscpd, ast-grep, doc links, glossary, secrets | 10-20 s |
| `commit-msg` | `git commit` | AI/tool attribution (`Co-Authored-By: Claude`, `Generated with`, 🤖, `noreply@anthropic.com`...), Avoid words (when `glossary.commit_msg`) | < 1 s |
| `pre-push` | `git push` | tamper on every pushed commit, changed, neighbouring and directly importing tests, a source change with no test found, `cov/diff` on fresh lcov, Gitleaks and audit, the `hooks.pre_push_timeout` and `hooks.pre_push_max_tests` limits | up to a minute |
| agent Stop | the agent ends a turn | `check` against `project.base`; red = one round of fixes | 10-20 s |
| manually | before pushing a large change, or to measure | full gate: all tests with coverage, mean CRAP, Gitleaks, audit, a report with worklist and hotspots | ~3 min |

CRAP is computed in `check` and in the hooks only when `.scratch/quality/lcov.info` is fresh (the
source fingerprint matches the one recorded in `lcov.meta.json`). A fast entry point never adopts a
saved red test result as its own: it writes `tests: not run (last full run <date>, <sha>)`. With no
fresh lcov at all the line stays `tests: not run, no fresh lcov` and only complexity is checked. Red
tests block the full gate and `pre-push`, where tests run in the current invocation.

`cov/diff` uses the same fresh lcov. The full gate and `pre-push` block low coverage. `check`,
`pre-commit` and Stop print a note but do not block. Without fresh lcov the output has
`cov/diff: not run, no fresh lcov` plus the number of changed source files with no coverage data. The
full gate blocks a changed source file that is missing from lcov, with the text `run tests with
coverage first`.

If a change contains only `.md`, `.toml`, `.json`, `.yml` or `.yaml` outside `project.src`, a fast
entry point writes `scope: docs-only`. It skips CRAP, `cov/diff`, deps, knip, eslint form and jscpd;
doc, glossary, secret and tamper stay, including the baseline and config guards.
The full entry point and `--update-baseline` always use `scope: all`; the docs-only shortcut applies
to `check`, the hooks and Stop only.

## Commands (one per action)

```bash
Q=~/.claude/skills/code-quality/scripts/quality.ts
bun $Q install-hooks <repo>          # wire the hooks: core.hooksPath for that repo only
bun $Q uninstall-hooks <repo>        # remove them (only when the path is ours); the previous core.hooksPath comes back
bun $Q --repo <repo> --update-baseline   # first snapshot of the debt (with tests); refresh after a merge
bun $Q --repo <repo>                 # full gate with tests and coverage
bun $Q --repo <repo> --skip-tests    # full gate on the lcov already on disk (refuses, exit 2, when it is stale)
bun $Q check --repo <repo>           # fast gate on the change (like the Stop adapter)
bun $Q check --repo <repo> --staged  # same on the staged change (like pre-commit)
bun $Q check --repo <repo> --since <rev>  # on the diff rev..HEAD (to replay an old commit)
bun $Q check --repo <repo> --all     # the whole repo, baseline ignored: measure debt and noise
```

Flags on top of `.quality.toml` (a flag beats the file): `--config <file>`, `--baseline <file>`,
`--src a,b`, `--base <ref>`, `--test-cmd`, `--max-cc`, `--max-crap`, `--forbid from:to`,
`--knip-ignore`, `--allow-red-tests`, `--no-deps`. With no `.quality.toml` the defaults apply
(languages detected from every manifest in every subfolder, `src = ["."]`, base `origin/main`).

## Wiring a new repo

1. Put `.quality.toml` in the repo root (a TypeScript sample: `examples/typescript.quality.toml`, a
   Python one: `examples/python.quality.toml`). The minimum is `[project] src` and `base`; the
   project's own canon goes into `[layers]`, `[glossary]`, `[docs]`, `[escalate]`.
   An unknown key is an error that names the key. A worktree without its own file reads the main
   checkout's file, so in a public repo the file can stay untracked (`.git/info/exclude`).
2. `.scratch/` in `.gitignore` (reports are written there; `install-hooks` warns when it is missing).
3. `bun $Q --repo <repo> --update-baseline` - a snapshot of the current debt. The baseline lives in the
   main checkout: `<main checkout>/.scratch/quality/baseline.json`, shared by all worktrees. Until it
   exists, the gate compares deps and knip against `project.base`: old cycles and knip entries do not
   block, new cycles and unused exports do. The output says once:
   `baseline: missing, run --update-baseline; N cycles / M knip entries not judged`.
   After updating the skill, run `--update-baseline` again: until then the new adapter tool lists do not
   block and give one hint, `baseline: no adapter tool list; run --update-baseline after updating code-quality`.
4. `bun $Q install-hooks <repo>`. It writes `core.hooksPath` into the repo's `.git/config`. Worktrees
   share that file: the hooks switch on in every worktree at once (the script says so). The repo's own
   hooks (Git LFS, husky and anything else) keep working, see "The repo's own hooks".
5. Optionally the agent Stop adapters: `adapters/ENABLE.md`.

## Bypasses and their trace

- Deleting a test block requires a `qg:test-removed <reason>` line. For a commit that already exists the
  line lives in its message. For `check --staged` and Stop it may live in
  `.scratch/quality/allow.md`. `pre-push`, the full gate and `pre-commit` do not read that file.
- `pre-push` with no test found accepts a `qg:no-test <reason>` line in the message of a pushed commit.
- A deliberate secret in a fixture accepts `qg:allow <reason>` or `gitleaks:allow <reason>`.
  A marker without a reason does not work. If the marker is added together with code,
  `tamper/baseline-touched` blocks the change.

Every accepted bypass prints `note: bypass <rule> <commit-msg|allow.md|inline> <reason>`.
The same lines sit in the `Bypasses` section of `check.md` and `check.json`. An empty reason is
accepted for no bypass at all.

`tamper/baseline-touched` also guards the settings that could narrow the gate. Changing such a key
together with sources is blocked. A separate config change gives a `note:` with the old and the new
value. Guarded: `[project] src`, every `[thresholds]`, every `[security]`,
`[hooks] pre_push_test_cmd`, `pre_push_max_tests`, `pre_push_timeout`, `[secrets] allow_users`,
every `[review]`, `[knip] ignore`, every `[layers]`, `[docs] globs`, `history_globs` and
`[glossary] allow`.

The last bypass of every hook: `git commit --no-verify` / `git push --no-verify`.

## The repo's own hooks (the chain)

`core.hooksPath` hides the hooks in `.git/hooks`, so every file in `hooks/` calls `hooks/_chain` at the
end: that runs the repo's hook of the same name, with the same arguments and the same stdin, and
returns its exit code. The repo's hook is looked up where git would look without the skill:

- `install-hooks` found another `core.hooksPath` (husky: `.husky/_`, `.husky`) - the path is recorded in
  `code-quality.previousHooksPath` of the local config, the chain goes there (a relative path is taken
  from the work tree root), `uninstall-hooks` puts it back into `core.hooksPath`;
- otherwise the `core.hooksPath` from `--global` or `--system` (read on every run, not remembered);
- otherwise `<git common dir>/hooks` (shared by worktrees).

In a repo where `core.hooksPath` is no longer ours (husky overwrote it) `uninstall-hooks` drops the
stale `code-quality.previousHooksPath`.

Order: `pre-commit`, `commit-msg`, `pre-push` give their verdict first, the repo's hook runs only on
green, and its red fails the operation. `pre-push` keeps the list of refs from stdin in a temporary
file and feeds it to both the gate and the repo's hook (Git LFS uploads objects right there). The
other names (`post-checkout`, `post-commit`, `post-merge`, `post-rewrite`,
`prepare-commit-msg`, `pre-rebase`, `pre-merge-commit`, `pre-auto-gc`, `applypatch-msg`,
`pre-applypatch`, `post-applypatch`) are symlinks to `_chain` and carry no check of their own. No
repo hook, or a non-executable one - exit 0. `install-hooks` prints which repo hooks joined the chain.

Verified 19.09.2026: a scratch repo with `git lfs install --local` and a png under LFS - after
`install-hooks` a push to a local bare repo calls `git-lfs pre-push`, the object lands in `lfs/objects`
of the remote; LFS also gets `post-checkout` and `post-commit`; a husky layout `.husky/_` with `h`
runs `.husky/pre-commit`, and `uninstall-hooks` restores `.husky/_`. Tests: `pipeline.test.ts`,
block `install-hooks chains the repo's own hooks` (including a `--global` `core.hooksPath`).
Repeat on 19.09.2026 in a scratch clone of another repo with `lfs.url=file://<bare>`: a commit with
complexity 12 was stopped, a clean first commit went through, `git-lfs pre-push` was called through
`hooks/pre-push`, the object landed in `lfs/objects` of the local bare repo, and the push log held no
`https://` at all.

The first commit of a repo without history is judged against an empty tree: git 2.55 does not know the
empty tree hash without the object, so the script writes it first (`git hash-object -t tree -w /dev/null`).

## Thresholds and why

One bar in every project (owner decision of 18.09.2026, item 1), in `[thresholds]`:

| threshold | value | where it holds |
|---|---|---|
| `max_cc` | 10 | a changed function more complex than this gets split |
| `max_crap` | 30 | a changed function with CRAP > 30 (with fresh lcov) needs tests or a split |
| `max_mean_crap` | 5 | warning threshold: a mean above 5 with a rise over baseline larger than `mean_tolerance` (0.01) gives a `note`, the exit code does not change |
| `cognitive_complexity` | 15 | sonarjs, changed functions |
| `max_depth` / `max_params` | 4 / 4 | eslint core |
| `max_lines_per_function` | 80 | no blank lines, no comments |
| `dup_min_tokens` | 70 | jscpd |
| `diff_coverage` | 0.8 | covered share of added executable lines |
| `min_release_age_days` | 1 | minimum age of a new or changed version in a lockfile |

- cc 10 and CRAP 30 are the classic crap4j borders: at 100% coverage CRAP = cc, so a function with
  cc ≤ 10 and tests always passes, while an uncovered function of cc 5 already hits 30. The earlier
  `--max-cc 3 --max-crap 4` failed normal functions and disagreed with the global bar.
- The mean does not fail the gate: on a real repo flaky tests move the coverage of single functions
  (measured 18.09: `attemptLock` 19 -> 46 with no code change), and one new good function with CRAP 6
  raises the mean. The state "above 5 and rising" is printed in Summary/Drift as `note: crap/mean`;
  what blocks is changed functions and ratchet findings.
- CRAP is not scientifically validated, it ranks risk ("hard and uncovered"). Bugs are best predicted
  by change history and size (Nagappan & Ball 2005; Tornhill & Borg 2022), hence the worklist by
  churn × CRAP.

## What it checks

Every check looks at the change only: functions whose lines were touched, and added lines.
Old debt does not block, it lives in the baseline and in `check --all`.

| rule | what it catches | how |
|---|---|---|
| `crap` | cc > 10, CRAP > 30 in a changed function; the diagnostic mean; red tests in the full gate | ESLint AST for TS/JS, Radon 6.0.1 for Python, Lizard 1.24.0 for the other languages and as a fallback; LCOV |
| `deps/cycle` | a new import cycle | the adapter's `cycles` command and the shared ratchet; TS keeps `dependency-cruiser@18.3.1` and the layer rules |
| `dead/*` / `knip/unused` | a new unused file, export or dependency | the adapter's `dead` command and the shared ratchet; TS keeps `knip@6.36.0` |
| `form/*` | a new form, complexity or size problem | the adapter's `form` command and the shared ratchet; TS keeps ESLint/SonarJS with an in-memory config |
| `dup/jscpd` | a clone with one side on changed lines | `jscpd@5.2.1 --absolute` on changed sources only |
| `ast/empty-catch` | `catch {}`, a catch with a comment only, Python `except: pass` / `...` | inline rules per language and `rules/sg/*.yml`, ast-grep 0.45.3 |
| `ast/catch-only-logs` | a catch with `console.*`/`logger.*`/`log.*` only | same |
| `ast/textual-test` | in a test, `assert.match`/`.includes`/`toContain`/`toMatch` on a variable holding source text read with `readFileSync(... .ts)` | same |
| `doc/path`, `doc/line` | a repo path in backticks (`agent/x.ts`, `x.ts:12-20`) that does not exist, or a line past the end of the file | the path must resolve from an existing repo folder; bare names (`mcp.json`) and runtime paths are not checked; git-ignored files are skipped |
| `doc/symbol` | a code symbol in backticks (`fooBar`, `name()`) that is absent from the code | `git grep -w` without `*.md` |
| `doc/deleted` | docs referring to a file the change deletes or renames | `git grep` over `[docs] globs` |
| `glossary` | a word from an `_Avoid_:` line in added prose lines (`[glossary] globs`) and in the commit message | an Avoid line with a qualifier ("(this ...)", "for ...", "as ...", "...") is skipped whole: it names a sense, not a word, and the reviewer judges it; `allow` covers project homonyms |
| `secret/*` | tokens (AWS, `sk-...` keys with a digit, GitHub, Slack, Google, Telegram bot), a private key, a personal home-folder path (macOS or Linux, unless the name is an allowed service user), a `.env` in the change | placeholder names (`user`, `john`, ...) and `[secrets] allow_users` are allowed; a deliberate secret needs `qg:allow <reason>` or `gitleaks:allow <reason>` |
| `secret/gitleaks` | secrets in the commits `project.base..HEAD` | full gate and `pre-push`; `gitleaks git --redact`; the raw JSON is deleted after reading; without the binary an explicit line, not a block |
| `deps/lock-age` | a new or changed lock entry younger than `min_release_age_days` | npm/PyPI publication time; cache `.scratch/quality/pkg-age.json`; offline an explicit line, not a block |
| `deps/new-package` | a new direct `dependencies`/`devDependencies` in `package.json` or `pyproject.toml` | a `note:` expecting `qg:dep <name> <why>` in the report; no block |
| `deps/audit` | a new known vulnerability in a dependency | one OSV Scanner `-L` per lockfile found, one result per repo; full gate and `pre-push`; shared ratchet |
| `commit/attribution` | AI attribution in a commit | `commit-msg`; "with codex" as a product word is not caught, only "written/generated/created/... with/by <tool>"; the `git commit -v` diff below the scissors line is not read |
| `tamper/test-deleted` | a deleted test file, or a block title that is gone and does not come back in plain, skip/todo/only form; renaming a title with the same meaning is not a deletion | block; the explicit reason is described in "Bypasses and their trace" |
| `tamper/test-skipped` | an added skip, only, todo or xfail | block |
| `tamper/assertion-weakened` | fewer assertions in the hunk, or an exact `assert.equal` / `expect(...).toEqual` / unittest / Python `assert x == y` replaced by a truthy/existence check; removing `readFileSync` checks of source text is allowed when they move into new tests without lowering the total assertion count | block; `qg:test-removed` lifts `tamper/test-deleted` only |
| `tamper/mock-added` | a test mocks a module that is not among the changed sources, or a local stub shadows an imported/exported function of a source file | a note with file, line, name and source |
| `tamper/baseline-touched` | sources change together with the baseline or the thresholds; an allow marker mixed with other code | block; a separate change of a service file gives a note |
| `tamper/no-tests-ran` | `pre-push` sees sources but finds no changed, neighbouring or directly importing test | block until a test exists or `qg:no-test <reason>` |
| `cov/diff` | less than 80% of added executable lines covered | lcov defines the executable lines; the output lists up to 20 uncovered `file:line` |

`[escalate] paths` (auth, for example) prints `note: reviewer paths touched` and does not block: the
reviewer is not wired yet.

## Languages and check availability

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

Every rule was checked on a deliberately bad example in a TypeScript probe repo and a Python probe
repo. Noise on a real repo is the next section.

## Noise on a real repo (origin/main 2ccbc123, 18.09.2026)

Three measurements in a scratch worktree (deleted afterwards), config `examples/typescript.quality.toml`:
(1) `check` on a clean main, (2) `check --all` over the whole tree = debt, (3) `check --since c~1` on the
last 40 commits of main = how many already accepted commits the hook would have stopped. Plus
`commit-msg` on the last 300 messages.

| rule | clean main | whole tree (debt) | 40 commits: stopped | verdict |
|---|---|---|---|---|
| `crap` (cc > 10) | 0 | 231 functions | 7 commits (12 functions: `handleControl` cc 105, `pipeline` 37, ...) | correct: touching an old complex function means splitting it first |
| `deps` | 0 | 0 cycles | 0 | - |
| `knip` | 0 (the baseline has no knip list yet, report only) | 112 | 0 | switches on after `--update-baseline` |
| `form/cognitive-complexity` | 0 | 103 | 7 commits | correct, the same functions as `crap` |
| `form/max-lines-per-function` | 0 | 84 | 2 | correct |
| `form/max-params` | 0 | 16 | 0 | - |
| `form/max-depth` | 0 | 12 | 0 | - |
| `dup/jscpd` | 0 | 21 clones | 1 (9 lines inside `version-layout.ts`) | correct |
| `ast/empty-catch` | 0 | 105 (97 + 8 Python in `services/`) | 1 | correct by the canon (the error is swallowed) |
| `ast/catch-only-logs` | 0 | 21 | 0 | - |
| `ast/textual-test` | 0 | 54 in 11 files | 0 | correct; before the rule was narrowed to "a variable from readFileSync" there were 350, the false ones being checks on function output |
| `doc/path`, `doc/line` | 0 | 0 + 2 (without ADR and CHANGELOG; with them it was 3 + 4) | 1 (`version-store.ts:766-900` in a file of 885 lines) | correct: doc drift; before narrowing to "a path with a slash from a repo folder" there were 111, the false ones being runtime file names |
| `doc/symbol` | 0 | 4 (without ADR and CHANGELOG; with them it was 9) | 0 (it was 1: `firePrompt`, `recordWakeError` in an ADR) | that stop was false: the ADR records that the symbols were deleted. ADRs and CHANGELOG are now in `docs.history_globs` and are not checked. Of the 4 in the tree, 3 are false (external names: `accessNotConfigured` from a Google API, `inputChars` from another service), 1 is arguable (`isExistingCard()` in a PRD) |
| `glossary` | 0 | 76 (after `allow`) | 0 (2 before `allow`: `override` = npm overrides, `cron` = system cron) | noisy on common words from Russian Avoid lines ("страница", "запись", "форма"): new lines only, the owner decides |
| `secret/*` | 0 | 13 (the owner's name in fixtures, fake tokens in scanner tests) | 0 | correct; fixtures get `qg:allow` |
| `commit/attribution` | - | 0 of 300 messages | - | - |
| `glossary` in commits | - | 16 of 300 before `allow`, 0 after | - | all 16 were homonyms (`job`, `poller`, `cron`) |

In total the hook would have stopped 12 of 40 accepted commits of main, 10 of them for touching an old
function above the bar (`crap`/`form`). That is the bar, not noise. Time of `check` on that repo:
14 s on average, 27 s at most.

### Tamper and diff coverage, 21.09.2026

Command: `bun scripts/quality.ts check --repo <repo> --since HEAD~40`.
HEAD was `19e55b49`, lcov fresh.

| rule | result on 40 commits | verdict |
|---|---|---|
| `tamper/test-deleted` | 1 file, commit `5fba2690` | correct: a 290-line test was deleted together with a behaviour change; the message holds no explicit reason |
| `tamper/test-skipped` | 0 | no noise found |
| `tamper/assertion-weakened` | 11 hunks in 2 commits (`5fba2690`, `679acca2`) | correct: checks were removed in two refactorings; the new policy demands a reason |
| `tamper/mock-added` | 0 notes | no noise found |
| `tamper/baseline-touched` | 0 | no noise found |
| `tamper/no-tests-ran` | not measured | the rule runs in `pre-push` only; the `check` command does not call it |
| `cov/diff` | 99.6%: 2678 of 2688 lines, no stops | correct |

The new rules stopped 2 of 40 commits. There are no false stops under the given policy. The same run
went from 9.63 s to 13.41 s, up 3.78 s.

### Security, 21.09.2026

Command: `bun scripts/quality.ts check --repo <repo> --since HEAD~40`. Two repos were measured
(`19e55b49` and `714d65bb4`). The full result lies in `.scratch/quality/check.md` of each repo.

| rule | repo A: stopped | repo B: stopped | verdict |
|---|---:|---:|---|
| `deps/lock-age` | 0 | 0 | correct: in repo A only the project's own version changed; in repo B the final diff has no lock entries |
| `deps/new-package` | 0 | 0 | correct: no new direct dependencies in the final diff |
| `secret/gitleaks` | not run by `check` | not run by `check` | by contract it runs in the full gate and `pre-push` only |
| `deps/audit` | not run by `check` | not run by `check` | by contract it runs in the full gate and `pre-push` only |

Re-check after installing the tools: Gitleaks `8.30.1` and OSV Scanner `2.6.0` are installed.
Gitleaks findings block the full gate and `pre-push`; the scanner runs with `--redact`, and the raw
JSON is deleted after reading. `deps/audit` runs OSV Scanner with an explicit `-L` per lockfile found,
folds the result into one line per repo and blocks new findings through the ratchet from
`baseline.tools`. On repo B a live OSV run found 18 records, 15 unique; the current baseline without
`tools` does not judge that old debt until `--update-baseline` and prints an explicit note.

## .quality.toml

Sections and keys (defaults in `scripts/lib/config.ts`, `DEFAULTS`):

- `[project]` `language` (a string, a list of `ts`, `py`, `go`, `rust`, `java`, `kotlin`, `csharp`,
  `swift`, `php`, `ruby`, `cpp`, `dart`, or empty = auto over all manifests), `src` (folders), `base`
  (the ref for "the change"), `test_cmd` (the full gate; it must write lcov to `$QG_LCOV`, with
  `$QG_DIR` = `.scratch/quality`).
- `[thresholds]` see "Thresholds", including the warning `max_mean_crap`, `diff_coverage = 0.8` and
  `min_release_age_days = 1`.
- `[layers] forbid = ["^agent/:^scripts/"]` - path regexes from:to.
- `[knip] ignore` - globs.
- `[glossary] path`, `marker` (`_Avoid_:`), `allow`, `globs`, `commit_msg`.
- `[docs] globs` - files whose links must resolve; `history_globs` (default `docs/adr/**`,
  `CHANGELOG.md`) - history: it names deleted files and symbols, those files are not checked.
- `[secrets] allow_users` - home folder names that are not a developer machine.
- `[security] gitleaks`, `audit` - switches for Gitleaks and the dependency audit; both `true` by default.
- `[escalate] paths` - path globs for "always to the reviewer".
- `[hooks] pre_push_test_cmd` (`{files}` = the test list; default `node --test {files}` or
  `uv run --with pytest pytest -q {files}`), `pre_push_timeout` (seconds), `pre_push_max_tests`
  (at most 40 test files per push). For TS/JS the selection includes direct relative imports,
  `require` and aliases from `tsconfig.json` `compilerOptions.paths`; dependency depth is one import.
- `[review]` `jev` (default `false`), `jev_model` (`typesafe/jev-1.13-20260917`), `jev_max_states`
  (12); switches `textual_test`, `error_path_tested`, `assertion_weakened`, `mock_hides_behavior`,
  `property_is_tautology` (all `true` by default); thresholds `textual_test_threshold` (0.85),
  `error_path_tested_threshold` (0.5), `assertion_weakened_threshold`, `mock_hides_behavior_threshold`,
  `property_tautology_threshold` (the last three at 0.7). `llm` is not wired yet, `true` gives one
  `note:` line.
  Reviewers never block (owner decision 3).

The list of guarded keys and the rule for changing them together with sources is in
"Bypasses and their trace".

## Limits (scanners and network)

- `secret/gitleaks` checks the history `project.base..HEAD`. It does not check an uncommitted file.
  The fast `secret/*` regexes check the added lines of the working change separately.
- Without `gitleaks` installed the gate writes `secret/gitleaks: not installed (brew install gitleaks)`
  and keeps going. There is no automatic install.
- `deps/lock-age` understands text `bun.lock`, npm lockfile v2/v3, `pnpm-lock.yaml`, `uv.lock`
  and `poetry.lock`. Local, workspace, git and file dependencies have no registry date and are skipped.
- No network, or no local OSV database - not a block. `deps/lock-age` writes `not checked (offline)`,
  and OSV Scanner gives `not run: deps/audit (OSV database unavailable)`. A missing lockfile is
  different and gives `not run: deps/audit (osv-scanner: no packages found)`. An unreadable answer or
  another tool failure stays a gate error.
- `cycles`, `dead`, `form` and `audit` findings are kept in the baseline under shared keys. A new
  finding blocks, an existing one stays debt. An old baseline without the adapter lists asks for
  `--update-baseline` and does not declare the old debt new.

## Jev: test notes (never block)

After the deterministic checks, `check`, `pre-commit` and the Stop adapter ask Jev (TypeSafe) through
OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`, the key `OPENROUTER_API_KEY` from the
environment, the model pinned by version `typesafe/jev-1.13-20260917` (a pinned slug exists on
OpenRouter; do not take the alias `~typesafe/jev-latest`, the thresholds would drift). Switch it on
with `[review] jev = true`. Code: `scripts/lib/jev.ts`. The first two questions come from pilot 2 with
its wording, state shape and threshold (the pilot report of 18.09.2026):

| question | when it is asked | state | note |
|---|---|---|---|
| `textual_test` (variant B) | every added hunk of a test file | `file`, `added_test_code` (+ hunk lines) | p ≥ 0.85: the test reads a project file and checks its text. Complements `ast/textual-test`: it also catches text checks of `.md`, `.css`, SQL |
| `error_path_tested` (variant A) | test hunks, only when the change adds `throw`, `catch`, `reject(`, an error return | `file`, `diff_hunk` (the hunk with 3 lines of context) | p < 0.5: the code added an error path and this test hunk does not exercise it |
| `assertion_weakened` | the test hunk has both removed and added lines | `file`, `test_hunk` | p ≥ 0.7: the test became easier to pass because an assertion was removed or loosened |
| `mock_hides_behavior` | the hunk holds `vi.mock`, `jest.mock`, `monkeypatch`, `@patch`, `mocker.patch` or a local stub found by `tamper/mock-added` | `file`, `test_hunk`, `changed_source_files` | p ≥ 0.7: a mock or stub bypasses the changed behaviour of the code or of a direct dependency |
| `property_is_tautology` | the hunk holds `fc.assert`, `fc.property`, `@given` or `hypothesis` | `file`, `test_hunk` | p ≥ 0.7: the property-based test restates the implementation or filters away almost every input |

All applicable questions of one hunk go in one request; there are at most `jev_max_states` (12) hunks,
5 s for the whole change. Output:

- `note: jev <question> p=<p> >=|< <threshold>  <file>:+<hunk line>  <meaning>` - a note;
- `jev: <n> of <m> hunk(s) answered, <k> note(s), <model>` - the summary, always printed;
- `jev: not available (<reason>)` - no key, HTTP error, timeout, broken answer. Not a silent skip and
  not a block: only the deterministic checks decide the exit code;
- `jev: nothing to ask (no added test hunks)`.

**The notes are provisional.** The thresholds were chosen on the pilot sample, with Opus as the
reference. They become final after the owner's blind labels (not done yet). Every answer is written to
`<main checkout>/.scratch/quality/jev-log.jsonl` (`question`, `p`, `file`, `hunk`, `sha` = HEAD at
check time, for pre-commit the commit's parent, `scope`, `noted`) so the thresholds can be revisited
after a month of use. `fallback_hides_required` is off: it failed the pilot.

### Jev: known false positives

- `assertion_weakened p=0.88`, `agent/lib/reminder-store.property.test.ts:+246`, a clean Opus branch:
  a migration property test replaced the exact `schemaVersion === 2` with a check of the allowed set
  `2 || REMINDER_SCHEMA_VERSION`. A writer may keep an old valid schema or write the current one
  whole. That widens a correct invariant instead of weakening the proof. The threshold did not change;
  the decision waits for the owner's blind labels.

Rules for working with Jev (docs.typesafe.ai, notes from the pilot): one atomic question per property,
in English, only the fields the question reads in the state, a 32k-token limit per state; Noul returns
one probability with no confidence.

## How CRAP is computed (method A-exact-2)

`CRAP = cc² × (1 − cov)³ + cc`. `cc` and function ranges come from one analyzer per language: ESLint
AST for TS/JS, Radon 6.0.1 for Python, Lizard 1.24.0 for the other supported languages. Lizard
replaces the native analyzer only for a file that analyzer failed to parse. `cov` = the share of lcov
`DA` lines that fall inside the function's own range; `FN`/`FNDA` are not needed, the signature line
and the bodies of nested functions do not count, duplicate `SF` blocks are summed. No coverage data
means 0%.

## Report

`<repo>/.scratch/quality/report.md` (full gate) or `check.md` (`check` and the hooks), next to a `.json`
with every finding and tamper/cov note. The `Bypasses` section keeps the accepted bypasses with their
source and reason. The other sections: Gate (per rule), Escalate, Drift (unchanged functions worse
than the baseline, not gated), Summary, Worklist (CRAP × commits in 12 months, `tests` / `split` /
`tests+split`), Hotspots, Top 30 CRAP, Dependencies, Dead code. The folder also holds `lcov.info`,
`lcov.meta.json`, `tests.log`, `pre-push.log`, the temporary configs `depcruise.cjs`,
`knip.config.json` and the `jscpd/` report.

## Limits (working tree, hooks, tools)

- The analysis reads the working tree, so `pre-commit` refuses when a staged file also has unstaged
  edits (a partial `git add -p`): otherwise the commit would carry text that was never checked. Fix:
  stage the file whole, or `git stash push --keep-index`, commit, `git stash pop`.
- `doc/symbol` does not know external names: a field of someone else's API or library in backticks
  (`accessNotConfigured`) looks like a missing symbol.
- An anonymous function's name is the eslint label, `#n` by order in the file: a new anonymous function
  higher up shifts the numbers in Drift. Fixed with `--update-baseline` after the merge.
- jscpd runs on changed files only: a clone of changed code with an unchanged file stays invisible.
- Native `cycles`, `dead`, `form` and `audit` are not swapped for another language's tool. When an
  adapter command is not installed, the report writes the exact `not run` with the install command.
- The very first commit of a repo (no HEAD yet) is not checked by the hooks: the report fails on
  `git rev-parse HEAD`. Make the first commit with `--no-verify`, the hook works from there.
- The script's own tests: `bun test scripts/` in the skill folder (seam behaviour, Jev with a stubbed
  HTTP layer, one `check` run on a temporary repo, the hook chain with `.git/hooks` and with a husky
  path, the Stop key; the script's own mean CRAP is 3.6 at the coverage from these tests).
- Jev sees the test hunks of the language adapter's `testGlobs`; over a whole workflow there are fewer
  positives than in the pilot sample, so `textual_test` precision is lower (pilot estimate ~0.65).
- Flaky tests move coverage: on a changed function that can give a false CRAP > 30, rerun.
- `pre-push` runs the tests of the working tree, not of the pushed commit. It prints `touched tests: N
  by name, M by import`; importers are searched one level deep and cut off by the shared
  `hooks.pre_push_max_tests` limit. The first push of a new branch without `project.base` (no
  `origin/main`) takes the diff from the parent, the root commit from an empty tree.
- husky in `prepare` (`npm install`) rewrites `core.hooksPath` to `.husky/_` on its own and the skill's
  hooks switch off: run `install-hooks` again after installing dependencies. `git lfs install` in a repo
  with our `core.hooksPath` writes its hooks into the skill folder (or refuses when a file is already
  there): install LFS hooks before `install-hooks`, or with `--local` after `uninstall-hooks`.
- A trial push of an LFS repo goes into a scratch clone only (`GIT_LFS_SKIP_SMUDGE=1 git clone
  --shared`) where `origin` is removed, a remote named after a local bare repo exists and
  `lfs.url=file://<bare>`; before the push `git lfs env` must show `Endpoint=file://...`, and after it
  the log must hold no `https://`. With a bare path git-lfs takes the LFS address of `origin` and
  uploads objects to the real server (this happened on 19.09.2026 in a worktree of another repo: one
  trial png of 27 bytes went into the LFS store of GitHub, no refs were pushed; an object can be
  deleted from GitHub LFS only together with the repo). The `GIT_TRACE` log of such a push holds
  temporary tokens: do not keep it, delete it right after the check.
- Tools are installed through `npx -y pkg@version` and into `~/.cache/quality-gate` (eslint, when the
  repo has none, and sonarjs); the first run without network fails with an error instead of passing
  silently. Raise the versions by hand, comparing the report before and after.
