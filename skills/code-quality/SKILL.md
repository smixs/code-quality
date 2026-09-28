---
name: code-quality
description: "Code quality advisor for a repo: one bun script behind git hooks and Claude Code, Codex, Grok, pi, omp, and OpenCode adapters. Never blocks: raises loud RED FLAGs on dangerous moves (secrets, tampered or deleted tests, red tests on push, skipped git hooks) and reports CRAP and complexity on changed functions, diff coverage, new cycles, dead code, clones, vulnerable dependencies and AI attribution in commits as findings the agent weighs. 12 languages, one .quality.toml per repo. Use when: quality gate, CRAP, complexity, ratchet, baseline, hotspots, dead code, import cycles, wire a repo into the gate, install quality hooks, .quality.toml. Not for running ordinary tests, lint or typecheck."
---

# code-quality

## Overview

One script, `scripts/quality.ts`, called by every entry point. It advises and never forbids: the plugin trusts the agent the way a good reviewer trusts a colleague. It measures, shows what it found, and says loudly when something is dangerous; the agent decides what to do and says why. No hook stops a commit, a push, a tool call or the end of a turn.

Every output starts with the red flags, one line each: `RED FLAG: <what you are doing> -- <why it is dangerous>; check: <what to verify>`. Then come the findings (`FINDINGS (n), advice, nothing blocked:`) or `CLEAN`, then notes. Old debt lives in a baseline and is not reported as a finding; a new finding on a changed line is. Jev (a classifier) and other reviewers write notes only.

| entry point | when | what runs | time |
|---|---|---|---|
| `pre-commit` | `git commit` | `check --staged` on the staged change; prints the report, the commit goes ahead | 10-20 s |
| `commit-msg` | `git commit` | AI attribution, glossary words in the message; a note, the commit goes ahead | < 1 s |
| `pre-push` | `git push` | tamper per pushed commit, tests touched by name and by import, diff coverage, Gitleaks, OSV audit; the push goes ahead | up to 1 min |
| agent Stop | the agent ends a turn | `check` against `project.base`; the turn ends as the agent chose, the report reaches the agent once, with its next message | 10-20 s |
| shell guard | the agent runs `git` | a red flag next to the command's output when it skips the hooks (`--no-verify`, `commit -n`, `core.hooksPath`); the command runs | < 1 s |
| acceptance | a lead accepts a change | `check --since <base> --tests`: the change's touched tests with coverage, then the gate judges the change with that coverage | the touched tests + 10-20 s |
| mutant | proving the tests catch a bug | `mutant`: one exact mutation, the touched tests, a guaranteed restore, the verdict in the exit code | two runs of the touched tests |
| manual | to measure the repo | full gate, a debt measurement, not a verdict on a change: tests with coverage, mean CRAP, worklist, hotspots | 3-6 min |

The acceptance report on a change is `check --since <base> --tests`. The full gate reports old debt too, so its findings say nothing about one change; run it to measure the repo. `check`, the full gate and `mutant` exit 1 on findings so a script or CI can decide on its own; no hook turns that code into a stop.

CRAP needs fresh lcov (`<out_dir>/lcov.info`, by default `.scratch/quality`, with a matching fingerprint). Without it a fast entry point prints `tests: not run, no fresh lcov` and judges complexity only. A change of docs and config only (`.md`, `.toml`, `.json`, `.yml` outside `project.src`) prints `scope: docs-only` and skips the code checks.

The process around the gate, from the spec to landing, is the `acceptance` skill in this plugin: [../acceptance/SKILL.md](../acceptance/SKILL.md).

## Commands

```bash
Q=<plugin-root>/scripts/quality.ts
bun $Q install-hooks <repo>              # core.hooksPath for that repo only; repo hooks keep working
bun $Q uninstall-hooks <repo>            # put the previous core.hooksPath back
bun $Q --repo <repo> --update-baseline   # snapshot of the current debt (runs tests); repeat after a merge
bun $Q --repo <repo>                     # full report with tests and coverage
bun $Q --repo <repo> --skip-tests        # full report on the lcov already on disk (exit 2 when stale)
bun $Q check --repo <repo>               # fast report on the change (what the Stop hook runs)
bun $Q check --repo <repo> --staged      # the staged change (what pre-commit runs)
bun $Q check --repo <repo> --since <rev> # the diff rev..HEAD
bun $Q check --repo <repo> --all         # whole repo, baseline ignored: measure debt and noise
bun $Q check --repo <repo> --since <base> --tests   # acceptance: touched tests with coverage, then the report
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
5. Install the plugin for the agent as described in the repository README. Its Stop, next-prompt (`agent-notes`) and shell guard hooks load with the package.

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
| `min_release_age_days` | 1 | a new lock entry younger than this is a finding |

Why these numbers, and how CRAP is computed: [references/checks.md](references/checks.md).

## Red flags

Printed first, loud, never blocking. Each says what the agent is doing, why it is dangerous and what to verify:

| red flag | where |
|---|---|
| a secret in the change (`secret/token`, `secret/env-file`) or in the pushed history (`secret/gitleaks`) | every `check`, `pre-commit`, `pre-push`, Stop |
| a test deleted, skipped or weakened, an inline suppression, the baseline or guarded config changed with code (`tamper/*` except `tamper/no-tests-ran`) | every `check`, `pre-commit`, `pre-push`, Stop |
| red touched tests on push | `pre-push` |
| a git command that skips the hooks: `--no-verify`, `commit -n`, `-c core.hooksPath`, `git config core.hooksPath` | shell guard (`[hooks] flag_bypass = false` silences it) |

## What it reports

| rule family | catches |
|---|---|
| `crap`, `form/*` | complexity, CRAP, cognitive complexity, size and params over the bar on changed functions |
| `cov/diff` | added executable lines covered below `diff_coverage` (in the full gate, `pre-push` and `check --tests`) |
| `tests/red`, `tests/timeout` | a touched test fails or runs over `[tests] touched_timeout_s` in `check --tests` |
| `tamper/*` | deleted or skipped test, weakened assertion, baseline or guarded config changed with code, no tests ran |
| `deps/cycle`, `dead/*`, `dup/jscpd`, `ast/*` | new cycle, new unused export, new clone, empty catch, catch that only logs, textual test |
| `secret/*`, `secret/gitleaks`, `deps/audit`, `deps/lock-age` | tokens and keys, history secrets (red flags), a machine path, new vulnerability, too-young lock entry |
| `doc/*`, `glossary`, `commit/attribution` | dead path or symbol in docs, banned word, AI attribution in a commit |

Notes, without a count: `tamper/mock-added`, `deps/new-package`, `crap/mean`, `security/semgrep`, every `note: jev`. A missing tool prints one `not run` line with the install command.

Full rule table with how each one works: [references/checks.md](references/checks.md). Languages and adapters: [references/languages.md](references/languages.md).

## Saying why

Nothing needs a bypass to go through. A reason turns a finding into a traced decision: the finding leaves the list and the report keeps a `note: bypass <rule> <source> <reason>` line.

- Deleting a test block: `qg:test-removed <reason>` in the commit message (or in `<out_dir>/allow.md` for `check --staged` and Stop).
- `pre-push` or `check --since <rev> --tests` with no test found: `qg:no-test <reason>` in a commit message of the change. With `--tests` no tests run then, changed functions are judged by complexity only and `cov/diff` prints `not run`.
- A deliberate secret in a fixture: `qg:allow <reason>` or `gitleaks:allow <reason>` on the line.
- Changing `src`, thresholds, `[security]`, `[hooks]`, `[tests]`, `[review]`, `[knip]`, `[layers]`, `[docs]`, `[glossary] allow` together with source code raises `tamper/baseline-touched`; a separate commit keeps the two apart.

## Jev

An optional classifier: five yes/no questions on added test hunks, `change_untested` on changed source hunks, `spec_incomplete` against `[review] spec` or `$QG_SPEC`, opt-in UX and agent packs (`[review] ux_globs`, `agent_globs`) and project questions (`[[review.jev_questions]]`); calibrated probabilities, notes only, `[review] jev = true` plus a key: `TYPESAFE_API_KEY` for the TypeSafe API or `OPENROUTER_API_KEY` for OpenRouter, picked by `[review] jev_provider` (default `auto`). Details: [references/jev.md](references/jev.md).

## Common mistakes

- Reading `CLEAN` as "tests green": a fast entry point never runs tests. Check the `tests:` line; `check --tests` is the one that runs them.
- Scrolling past a `RED FLAG` because the commit went through: nothing blocks, so the flag is the only signal. Answer it: fix, or say why in the commit message.
- Running the full report to accept a change: it measures debt. Accept with `check --since <base> --tests`.
- Mutating by hand with `cp` and `sed`: `mutant` does the one exact edit and always restores.
- Pushing another branch from this checkout: `pre-push` runs the touched tests on the checked-out tree, so it skips them with `touched tests not run` unless the checkout is at the pushed commit and the files those tests read are committed. Push from that branch's worktree to have them run.
- Judging the mean CRAP: it is a note. The findings are changed functions and ratchet findings.
- A partial `git add -p`: `pre-commit` reads the working tree, so a file that also has unstaged edits is reported by its working-tree text (a `note: partly staged` line says so). Stage it whole for a report on the commit.
- husky in `npm install` rewrites `core.hooksPath`: run `install-hooks` again after installing dependencies.
- Skipping `--update-baseline` after updating the skill: the new adapter lists are not judged until then.
- Updating the baseline in the same commit as code: `tamper/baseline-touched` flags it by design.

More limits: [references/limits.md](references/limits.md). Report layout: [references/report.md](references/report.md).
