# Every check

The plugin advises and never forbids. Every check reports; none stops a commit, a push, a tool call or
the end of a turn. What can do real harm is a red flag, printed first in every output:

```
RED FLAG: <what you are doing> -- <why it is dangerous>; check: <what to verify>
```

The agent reads it and decides: fix it, or go ahead and say why (a commit message, a PR note, a
`qg:` marker). Everything else is a finding under `FINDINGS (n), advice, nothing blocked:`, or a
`note:` line. Red flags: `secret/token`, `secret/env-file`, `secret/gitleaks`, every `tamper/*` except
`tamper/no-tests-ran`, red touched tests on `pre-push`, and a git command that skips the hooks (the
shell guard, below).

Every check looks at the change only: functions whose lines were touched, and added lines.
Old debt is not a finding, it lives in the baseline and in `check --all`.

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
| `secret/*` | red flag: tokens (AWS, `sk-...` keys with a digit, GitHub, Slack, Google, Telegram bot), a private key, a `.env` in the change; a finding: a personal home-folder path (macOS or Linux, unless the name is an allowed service user) | placeholder names (`user`, `john`, ...) and `[secrets] allow_users` are allowed; a deliberate secret needs `qg:allow <reason>` or `gitleaks:allow <reason>` |
| `secret/gitleaks` | red flag: secrets in the commits `project.base..HEAD` | full gate and `pre-push`; `gitleaks git --redact`; the raw JSON is deleted after reading; without the binary an explicit `not run` line |
| `deps/lock-age` | a new or changed lock entry younger than `min_release_age_days` | publication time from the registry table in `lang.ts` (npm, PyPI, crates.io, Go proxy, RubyGems, Packagist, pub.dev, NuGet, Maven Central, deps.dev as fallback), a mirror through `[security] registry_urls`; cache `<out_dir>/pkg-age.json`; offline, or an ecosystem without a registry, an explicit `not run` line |
| `deps/new-package` | a new direct `dependencies`/`devDependencies` in `package.json` or `pyproject.toml` | a `note:` expecting `qg:dep <name> <why>` in the report |
| `deps/audit` | a new known vulnerability in a dependency | one OSV Scanner `-L` per lockfile found, one result per repo; full gate and `pre-push`; shared ratchet |
| `commit/attribution` | AI attribution in a commit | `commit-msg` prints a note, the commit goes ahead; "with codex" as a product word is not caught, only "written/generated/created/... with/by <tool>"; the `git commit -v` diff below the scissors line is not read |
| `tamper/test-deleted` | a deleted test file, or a block title that is gone and does not come back in plain, skip/todo/only form; renaming a title with the same meaning is not a deletion | red flag; the explicit reason is described in "Bypasses and their trace" |
| `tamper/test-skipped` | an added skip, only, todo or xfail | red flag |
| `tamper/assertion-weakened` | fewer assertions in the hunk, or an exact `assert.equal` / `expect(...).toEqual` / unittest / Python `assert x == y` replaced by a truthy/existence check; removing `readFileSync` checks of source text is allowed when they move into new tests without lowering the total assertion count | red flag; `qg:test-removed` answers `tamper/test-deleted` only |
| `tamper/mock-added` | a test mocks a module that is not among the changed sources, or a local stub shadows an imported/exported function of a source file | a note with file, line, name and source |
| `tamper/baseline-touched` | sources change together with the baseline or the thresholds; an allow marker mixed with other code | red flag; a separate change of a service file gives a note |
| pre-push tree | the touched tests run on the checked-out tree: a pushed ref that adds files and does not peel to `HEAD`, or uncommitted changes in a pushed file or a selected test | the touched tests do not run, the push goes ahead: `pre-push: touched tests not run: pushing <sha> (<ref>), this checkout is at <sha>; ...` or `pre-push: touched tests not run: uncommitted changes in files they read: <paths>; ...`; dirt elsewhere does not matter |
| `tamper/no-tests-ran` | `pre-push` or `check --tests` sees sources but finds no changed, neighbouring or importing test | a finding until a test exists or `qg:no-test <reason>` says why there is none |
| `cov/diff` | less than 80% of added executable lines covered | lcov defines the executable lines; the output lists up to 20 uncovered `file:line`; with `check --tests` a changed source missing from the touched lcov is also a finding |
| `tests/red` | `check --tests`: a touched test fails | a finding; the line names the log in the private run directory, which is kept |
| `tests/timeout` | `check --tests`: the touched run exceeds `[tests] touched_timeout_s` | a finding; the run's process group is killed |
| `tests: ERROR invalid coverage` | `check --tests` (a run that exits 0) and the full gate: the lcov is empty or unreadable (missing: this error for `check --tests`, `no coverage at <path>` with exit 2 for the full gate), has no `DA` line, a `DA` outside an `SF` ... `end_of_record` record, an `SF` inside an open record, an `end_of_record` with no open record (an orphan or a second one), a line that only starts with `end_of_record`, or a record left open; it applies to the full gate, a plain `check` and `--skip-tests` reading the full lcov | a finding |

## Acceptance and mutants

`check --since <base> --tests` is the report on a change. The full gate is a debt measurement: it
reports old debt, so it says nothing about one change. The touched coverage lives in
`<out_dir>/touched/run-<pid>-<random>/` and is read by that invocation only; the full gate,
`--skip-tests`, `--update-baseline` and a plain `check` never read it. Repo-wide report sections (mean,
median, drift, worklist, hotspots, top CRAP) say `n/a: touched coverage is not repo-wide`; the report
lists the changed functions with their touched coverage instead.

`mutant --file <path> --find <exact text> --replace <text> [--test <path>]...` checks that the tests
catch one concrete bug. The find text must occur exactly once in a regular UTF-8 file inside the repo
without staged changes. `--test` replaces the automatic selection and must name repo test files. The
selected tests first run on the original bytes (they must pass and run at least one test), then with
the mutation. Ran and failed come from the runner summary (node, bun, vitest, pytest; fixtures in
`scripts/fixtures/summaries/`). KILLED (exit 0) needs at least one failed test; SURVIVED (exit 1) needs
exit 0, no failure and at least one test; anything else, a timeout or an unreadable summary is
`MUTANT ERROR` (exit 2). State lives in `<out_dir>/mutant/lock/` (`<name>.orig`, `owner.json`): a live
pid holds the lock; a dead one's mutant is restored by the next run, and a target that is neither the
original nor the mutant is kept with its `.orig` for a person to decide. An `owner.json` that is not well formed (a positive integer `pid`, string `repo`, `file` and
`started_at`, two 64-hex sha256 values, this repo, a relative path inside it) is
`MUTANT ERROR: malformed mutant state <owner.json>; original at <.orig>`: nothing is written. Node counts a test file
without tests as one passing test.

`[escalate] paths` (auth, for example) prints `note: reviewer paths touched`: the reviewer is not
wired yet.

## Thresholds and why

- cc 10 and CRAP 30 are the classic crap4j borders: at 100% coverage CRAP = cc, so a function with
  cc ≤ 10 and tests always passes, while an uncovered function of cc 5 already hits 30. The earlier
  `--max-cc 3 --max-crap 4` failed normal functions and disagreed with the global bar.
- The mean is not a finding: on a real repo flaky tests move the coverage of single functions
  (measured 18.09: `attemptLock` 19 -> 46 with no code change), and one new good function with CRAP 6
  raises the mean. The state "above 5 and rising" is printed in Summary/Drift as `note: crap/mean`;
  the findings are changed functions and ratchet findings.
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

## The shell guard and the Stop report

The shell guard reads every shell command the agent runs. A direct `git commit --no-verify`,
`git commit -n` (also inside `-anm`), `git push --no-verify`, `git -c core.hooksPath=...` or
`git config core.hooksPath` gets a red flag next to the command's output; the command runs. The agent
reads it as context (`additionalContext` in Claude Code, Codex and Grok; the tool result in pi, omp and
OpenCode) and the user sees it too. `[hooks] flag_bypass = false` (old name `block_bypass`) silences it.

The Stop report never holds the turn. When the change has findings the session has not seen yet, the
user gets the red flags and the findings line at once, and the agent gets the full report once, with
its next message: `agent-notes` on UserPromptSubmit in Claude Code and Codex, the next-turn message
channel in pi and omp, a message without a reply in OpenCode. The same findings are not shown twice in
a session. Grok drops the context of a UserPromptSubmit hook, so there the Stop report reaches the user
only.
