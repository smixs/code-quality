# Every check

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
| `deps/lock-age` | a new or changed lock entry younger than `min_release_age_days` | publication time from the registry table in `lang.ts` (npm, PyPI, crates.io, Go proxy, RubyGems, Packagist, pub.dev, NuGet, Maven Central, deps.dev as fallback), a mirror through `[security] registry_urls`; cache `<out_dir>/pkg-age.json`; offline, or an ecosystem without a registry, an explicit line, not a block |
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

## Thresholds and why

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

## How CRAP is computed (method A-exact-2)

`CRAP = cc² × (1 − cov)³ + cc`. `cc` and function ranges come from one analyzer per language: ESLint
AST for TS/JS, Radon 6.0.1 for Python, Lizard 1.24.0 for the other supported languages. Lizard
replaces the native analyzer only for a file that analyzer failed to parse. `cov` = the share of lcov
`DA` lines that fall inside the function's own range; `FN`/`FNDA` are not needed, the signature line
and the bodies of nested functions do not count, duplicate `SF` blocks are summed. No coverage data
means 0%.
