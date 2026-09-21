# What the gate checks

Every rule is deterministic. A finding on a changed line fails the run. Old debt lives in the baseline and does not block.

| rule | what it catches | block or note |
|---|---|---|
| `crap` | a changed function with cc > 10 or CRAP > 30 | block, with fresh lcov |
| `form/cognitive-complexity` | changed functions over cognitive complexity 15 | block |
| `form/max-lines-per-function`, `form/max-params`, `form/max-depth` | 80 lines, 4 params, 4 levels of nesting | block |
| `cov/diff` | less than 80% of added executable lines covered | block in the full gate and `pre-push`, note in `check` |
| `tamper/test-deleted` | a deleted test file or block title that does not come back in plain, skip, todo or only form | block |
| `tamper/test-skipped` | an added skip, only, todo or xfail | block |
| `tamper/assertion-weakened` | fewer assertions in the hunk, or a strong matcher replaced by a truthy check | block |
| `tamper/mock-added` | a test mocking a module outside the change, or a local stub shadowing a source function | note |
| `tamper/baseline-touched` | sources changed together with the baseline, the thresholds or a bypass marker | block |
| `tamper/no-tests-ran` | `pre-push` sees sources but no changed, neighbouring or importing test | block |
| `deps/cycle` | a new import cycle, including layer rules from `[layers] forbid` | block |
| `dead/*`, `knip/unused` | a new unused file, export or dependency | block |
| `dup/jscpd` | a clone with one side on changed lines | block |
| `ast/empty-catch` | `catch {}`, a catch with a comment only, Python `except: pass` / `...` | block |
| `ast/catch-only-logs` | a catch that only calls `console.*` / `logger.*` / `log.*` | block |
| `ast/textual-test` | a test asserting on the source text of a project file | block |
| `secret/*` | tokens (AWS, `sk-...`, GitHub, Slack, Google, Telegram bot), a private key, a home-folder path, a `.env` | block |
| `secret/gitleaks` | secrets in the commits `project.base..HEAD` | block in the full gate and `pre-push` |
| `deps/audit` | a new known vulnerability, one OSV Scanner run per lockfile | block in the full gate and `pre-push` |
| `deps/lock-age` | a new lock entry younger than `min_release_age_days` | block when the registry answers |
| `deps/new-package` | a new direct dependency in `package.json` or `pyproject.toml` | note |
| `doc/path`, `doc/line`, `doc/symbol`, `doc/deleted` | a backticked repo path, line range or symbol that does not exist, and docs naming a file the change deletes | block |
| `glossary` | an Avoid word in added prose and in the commit message | block, with an `allow` list for homonyms |
| `commit/attribution` | `Co-Authored-By: Claude`, `Generated with`, robot emoji, `noreply@anthropic.com` | block in `commit-msg` |
| `security/semgrep` | the project's Semgrep rules, when a config is present | note |

## The CRAP metric

`CRAP = cc² × (1 − cov)³ + cc`, from Alberto Savoia and Brian Cunningham. A function with cc 5 and no coverage already scores 30. A function with cc 10 and full coverage passes with the same score: the metric ranks "hard to read and untested". Thresholds live in `[thresholds]` of `.quality.toml`: cc 10, CRAP 30, cognitive complexity 15, 80 lines per function, 4 params, 4 levels of nesting, 80% diff coverage.

Coverage comes from lcov. Function ranges and cc come from one analyzer per language: ESLint AST for TS/JS, Radon for Python, Lizard for the rest.

## Three modes

| mode | scope | what runs | measured time |
|---|---|---|---|
| `check` | the change against `project.base`, plus uncommitted work | tamper, CRAP and form on changed functions, duplication, ast-grep rules, doc links, glossary, secrets | 3-19 s |
| `pre-push` | every pushed commit, plus the tests it touched | tamper per commit, touched tests by name and by import, `cov/diff` on fresh lcov, Gitleaks, OSV audit | 1-39 s at a 180 s timeout |
| full gate | the whole tree, with tests and coverage | everything, plus red tests, mean CRAP, worklist and hotspots | 234-332 s |

A shortcut never invents data: with no fresh lcov the output says `tests: not run, no fresh lcov` and only complexity is judged. A fast mode never adopts a red test result from an older run.

## Baseline ratchet

`--update-baseline` writes a snapshot of the current findings to `<main checkout>/.scratch/quality/baseline.json`, shared by all worktrees. From then on a known cycle, a known unused export, a known duplicate stays debt, and the same finding on a changed line fails the run. Before the first snapshot the gate compares against `project.base` and says so.

## Notes and `not run`

Notes (exit code unchanged): `note: jev ...`, `note: crap/mean ...`, `note: tamper/mock-added ...`, `note: deps/new-package ...`, `note: bypass <rule> <source> <reason>`.

`not run` (exit code unchanged): a missing external tool becomes one line with the install command, for example `secret/gitleaks: not installed (brew install gitleaks)` or `cov/diff: not run, no fresh lcov`. An unreadable tool answer is a gate error, not a silent pass.
