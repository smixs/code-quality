---
name: code-quality
description: "Quality gate for a repo: one bun script behind git hooks and Claude Code, Codex, Grok, pi, omp, and OpenCode adapters. Blocks test tampering, high CRAP and complexity on changed functions, low diff coverage, new cycles, dead code, clones, secrets, vulnerable dependencies and AI attribution in commits. 12 languages, one .quality.toml per repo. Use when: quality gate, CRAP, complexity, ratchet, baseline, hotspots, dead code, import cycles, wire a repo into the gate, install quality hooks, .quality.toml. Not for running ordinary tests, lint or typecheck."
---

# code-quality

## Overview

One script, `scripts/quality.ts`, called by every entry point. Only deterministic checks decide the exit code. Old debt lives in a baseline and does not block; a new finding on a changed line does. Jev (a classifier) and other reviewers write notes only.

| entry point | when | what runs | time |
|---|---|---|---|
| `pre-commit` | `git commit` | `check --staged` on the staged change | 10-20 s |
| `commit-msg` | `git commit` | AI attribution, glossary words in the message | < 1 s |
| `pre-push` | `git push` | tamper per pushed commit, tests touched by name and by import, diff coverage, Gitleaks, OSV audit | up to 1 min |
| agent Stop | the agent ends a turn | `check` against `project.base`; red = one round of fixes | 10-20 s |
| acceptance | a lead accepts a change | `check --since <base> --tests`: the change's touched tests with coverage, then the gate judges the change with that coverage | the touched tests + 10-20 s |
| mutant | proving the tests catch a bug | `mutant`: one exact mutation, the touched tests, a guaranteed restore, the verdict in the exit code | two runs of the touched tests |
| manual | to measure the repo | full gate, a debt measurement, not a verdict on a change: tests with coverage, mean CRAP, worklist, hotspots | 3-6 min |

The acceptance verdict on a change is `check --since <base> --tests`. The full gate is red on old debt, so its verdict says nothing about one change; run it to measure the repo.

CRAP needs fresh lcov (`<out_dir>/lcov.info`, by default `.scratch/quality`, with a matching fingerprint). Without it a fast entry point prints `tests: not run, no fresh lcov` and judges complexity only. A change of docs and config only (`.md`, `.toml`, `.json`, `.yml` outside `project.src`) prints `scope: docs-only` and skips the code checks.

The process around the gate, from the spec to landing, is the `acceptance` skill in this plugin: [../acceptance/SKILL.md](../acceptance/SKILL.md).

## Commands

```bash
Q=<plugin-root>/scripts/quality.ts
bun $Q install-hooks <repo>              # core.hooksPath for that repo only; repo hooks keep working
bun $Q uninstall-hooks <repo>            # put the previous core.hooksPath back
bun $Q --repo <repo> --update-baseline   # snapshot of the current debt (runs tests); repeat after a merge
bun $Q --repo <repo>                     # full gate with tests and coverage
bun $Q --repo <repo> --skip-tests        # full gate on the lcov already on disk (exit 2 when stale)
bun $Q check --repo <repo>               # fast gate on the change (what the Stop hook runs)
bun $Q check --repo <repo> --staged      # the staged change (what pre-commit runs)
bun $Q check --repo <repo> --since <rev> # the diff rev..HEAD
bun $Q check --repo <repo> --all         # whole repo, baseline ignored: measure debt and noise
bun $Q check --repo <repo> --since <base> --tests   # acceptance: touched tests with coverage, then the gate
bun $Q mutant --repo <repo> --file <path> --find <exact text> --replace <text> [--test <path>]...
```

`check --tests` needs exactly one `--since`. It selects the touched tests (by name, including `<stem>.<anything>.test.<ext>` such as `X.render.test.ts` for `X.tsx`; for TS every test that reaches the changed file through any chain of imports, re-exports, dynamic imports, `require` and quoted paths in tests, with modules resolved through relative paths, the nearest `tsconfig.json` `paths` and workspace packages; see references/config.md), runs all of them with coverage into a private `<out_dir>/touched/run-*/` directory, and judges the change with that coverage: a red test is `tests/red`, a timeout `tests/timeout`, low coverage of added lines `cov/diff`. That coverage never feeds the full gate, `--skip-tests` or the baseline. Ctrl-C or SIGTERM during the run (or during pre-push tests) kills the test process group and exits 130 or 143; `check --tests` prints the kept run directory.

`mutant` runs the selected tests on the original file first, then with the one mutation: exit 0 `MUTANT KILLED` (a test failed), 1 `MUTANT SURVIVED` (they stayed green), 2 `MUTANT ERROR` (anything unclear). The file is restored and proven by sha256 on every outcome, including Ctrl-C; a run killed with SIGKILL is restored by the next `mutant`. Each run appends one JSON line to `<out_dir>/mutants.log`. A value that starts with `-` goes as `--find=<text>`.

Every test run the gate starts (full gate, `--tests`, pre-push, `mutant`) first waits while the 1-minute load is above `[tests] max_load` (twice the CPU count by default), up to `[tests] load_wait_s`, and prints `tests: waited Ns for load X.X (max M)`.

Flags beat `.quality.toml`: `--config`, `--baseline`, `--src a,b`, `--base <ref>`, `--test-cmd`, `--max-cc`, `--max-crap`, `--forbid from:to`, `--knip-ignore`, `--allow-red-tests`, `--no-deps`.

Nothing is wired to one machine or one vendor: `[project] base` left empty is detected from `origin/HEAD`, then `origin/main`, `origin/master`, `main` (the report header says which). `[project] out_dir` moves every report, the baseline and the logs. `[tools]` overrides a pinned version or a binary path (`jscpd = "5.3.0"`, `gitleaks = "/opt/bin/gitleaks"`). `[review] jev_provider` chooses the Jev endpoint. `[security] registry_urls` points a package registry at a mirror. Every key: [references/config.md](references/config.md).

## Wire a repo

1. Add `.quality.toml` to the repo root. Minimum: `[project] src` and `base`. Samples: [TypeScript](../../examples/typescript.quality.toml), [Python](../../examples/python.quality.toml). Keys: [references/config.md](references/config.md).
2. Add `.scratch/` to `.gitignore`; reports go there (`[project] out_dir` moves them).
3. `bun $Q --repo <repo> --update-baseline`. The baseline lives in the main checkout, shared by worktrees. Without it the gate compares against `project.base` and says so. Run it again after updating the skill.
4. `bun $Q install-hooks <repo>`. Existing hooks (husky, Git LFS) are chained, see [references/hook-chain.md](references/hook-chain.md).
5. Install the plugin for the agent as described in the repository README. Its Stop and shell guard hooks load with the package.

## Thresholds

One bar for every repo, in `[thresholds]`:

| key | value | holds where |
|---|---|---|
| `max_cc` | 10 | a changed function above it gets split |
| `max_crap` | 30 | a changed function above it needs tests or a split |
| `max_mean_crap` | 5 | warning only: `note: crap/mean` when above and rising |
| `cognitive_complexity` | 15 | changed functions |
| `max_depth`, `max_params` | 4, 4 | changed functions |
| `max_lines_per_function` | 80 | without blanks and comments |
| `dup_min_tokens` | 70 | jscpd |
| `diff_coverage` | 0.8 | covered share of added executable lines |
| `min_release_age_days` | 1 | a new lock entry younger than this blocks |

Why these numbers, and how CRAP is computed: [references/checks.md](references/checks.md).

## What blocks

| rule family | catches |
|---|---|
| `crap`, `form/*` | complexity, CRAP, cognitive complexity, size and params over the bar on changed functions |
| `cov/diff` | added executable lines covered below `diff_coverage` (blocks in the full gate, `pre-push` and `check --tests`) |
| `tests/red`, `tests/timeout` | a touched test fails or runs over `[tests] touched_timeout_s` in `check --tests` |
| `tamper/*` | deleted or skipped test, weakened assertion, baseline or guarded config changed with code, no tests ran |
| `deps/cycle`, `dead/*`, `dup/jscpd`, `ast/*` | new cycle, new unused export, new clone, empty catch, catch that only logs, textual test |
| `secret/*`, `secret/gitleaks`, `deps/audit`, `deps/lock-age` | tokens and keys, history secrets, new vulnerability, too-young lock entry |
| `doc/*`, `glossary`, `commit/attribution` | dead path or symbol in docs, banned word, AI attribution in a commit |

Notes only: `tamper/mock-added`, `deps/new-package`, `crap/mean`, `security/semgrep`, every `note: jev`. A missing tool prints one `not run` line with the install command and never changes the exit code.

Full rule table with how each one works: [references/checks.md](references/checks.md). Languages and adapters: [references/languages.md](references/languages.md).

## Bypasses

Every bypass needs a reason and leaves a `note: bypass <rule> <source> <reason>` line in the report.

- Deleting a test block: `qg:test-removed <reason>` in the commit message (or in `<out_dir>/allow.md` for `check --staged` and Stop).
- `pre-push` or `check --since <rev> --tests` with no test found: `qg:no-test <reason>` in a commit message of the change. With `--tests` no tests run then, changed functions are judged by complexity only and `cov/diff` prints `not run`.
- A deliberate secret in a fixture: `qg:allow <reason>` or `gitleaks:allow <reason>` on the line.
- Changing `src`, thresholds, `[security]`, `[hooks]`, `[tests]`, `[review]`, `[knip]`, `[layers]`, `[docs]`, `[glossary] allow` together with source code is blocked; change them in a separate commit.

## Jev

An optional classifier: five yes/no questions on added test hunks, `change_untested` on changed source hunks, `spec_incomplete` against `[review] spec` or `$QG_SPEC`, opt-in UX and agent packs (`[review] ux_globs`, `agent_globs`) and project questions (`[[review.jev_questions]]`); calibrated probabilities, notes only, `[review] jev = true` plus a key: `TYPESAFE_API_KEY` for the TypeSafe API or `OPENROUTER_API_KEY` for OpenRouter, picked by `[review] jev_provider` (default `auto`). Details: [references/jev.md](references/jev.md).

## Common mistakes

- Reading `GATE PASS` as "tests green": a fast entry point never runs tests. Check the `tests:` line; `check --tests` is the one that runs them.
- Running the full gate to accept a change: it measures debt. Accept with `check --since <base> --tests`.
- Mutating by hand with `cp` and `sed`: `mutant` does the one exact edit and always restores.
- Pushing another branch from this checkout: `pre-push` runs the touched tests on the checked-out tree, so it blocks unless the checkout is at the pushed commit and the files those tests read are committed. Push from that branch's worktree.
- Judging the mean CRAP: it is a note. What blocks is changed functions and ratchet findings.
- A partial `git add -p`: `pre-commit` refuses a file that also has unstaged edits. Stage it whole.
- husky in `npm install` rewrites `core.hooksPath`: run `install-hooks` again after installing dependencies.
- Skipping `--update-baseline` after updating the skill: the new adapter lists do not block until then.
- Updating the baseline in the same commit as code: `tamper/baseline-touched` blocks it by design.

More limits: [references/limits.md](references/limits.md). Report layout: [references/report.md](references/report.md).
