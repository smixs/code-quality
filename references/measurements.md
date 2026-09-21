# Measurements on real repos

Dated runs that shaped the rules. Not part of the contract; kept so the numbers can be re-checked.

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

## Tamper and diff coverage, 21.09.2026

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

## Security, 21.09.2026

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
