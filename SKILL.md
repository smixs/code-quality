---
name: code-quality
description: "Quality gate for a repo: one bun script behind git hooks (pre-commit, commit-msg, pre-push) and the Stop hooks of Claude Code, Codex and pi. Blocks test tampering, CRAP and complexity over the bar on changed functions, low diff coverage, new cycles, dead code, clones, secrets, vulnerable dependencies and AI attribution in commits. 12 languages, one .quality.toml per repo. Use when: quality gate, CRAP, complexity, ratchet, baseline, hotspots, dead code, import cycles, wire a repo into the gate, install quality hooks, .quality.toml, Stop hook for quality. Not for running ordinary tests, lint or typecheck."
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
| manual | before a large push, or to measure | full gate: tests with coverage, mean CRAP, worklist, hotspots | 3-6 min |

CRAP needs fresh lcov (`<out_dir>/lcov.info`, by default `.scratch/quality`, with a matching fingerprint). Without it a fast entry point prints `tests: not run, no fresh lcov` and judges complexity only. A change of docs and config only (`.md`, `.toml`, `.json`, `.yml` outside `project.src`) prints `scope: docs-only` and skips the code checks.

## Commands

```bash
Q=~/.claude/skills/code-quality/scripts/quality.ts
bun $Q install-hooks <repo>              # core.hooksPath for that repo only; repo hooks keep working
bun $Q uninstall-hooks <repo>            # put the previous core.hooksPath back
bun $Q --repo <repo> --update-baseline   # snapshot of the current debt (runs tests); repeat after a merge
bun $Q --repo <repo>                     # full gate with tests and coverage
bun $Q --repo <repo> --skip-tests        # full gate on the lcov already on disk (exit 2 when stale)
bun $Q check --repo <repo>               # fast gate on the change (what the Stop hook runs)
bun $Q check --repo <repo> --staged      # the staged change (what pre-commit runs)
bun $Q check --repo <repo> --since <rev> # the diff rev..HEAD
bun $Q check --repo <repo> --all         # whole repo, baseline ignored: measure debt and noise
```

Flags beat `.quality.toml`: `--config`, `--baseline`, `--src a,b`, `--base <ref>`, `--test-cmd`, `--max-cc`, `--max-crap`, `--forbid from:to`, `--knip-ignore`, `--allow-red-tests`, `--no-deps`.

Nothing is wired to one machine or one vendor: `[project] base` left empty is detected from `origin/HEAD`, then `origin/main`, `origin/master`, `main` (the report header says which). `[project] out_dir` moves every report, the baseline and the logs. `[tools]` overrides a pinned version or a binary path (`jscpd = "5.3.0"`, `gitleaks = "/opt/bin/gitleaks"`). `[review] jev_provider` chooses the Jev endpoint. `[security] registry_urls` points a package registry at a mirror. Every key: [references/config.md](references/config.md).

## Wire a repo

1. Add `.quality.toml` to the repo root. Minimum: `[project] src` and `base`. Samples: `examples/typescript.quality.toml`, `examples/python.quality.toml`. Keys: [references/config.md](references/config.md).
2. Add `.scratch/` to `.gitignore`; reports go there (`[project] out_dir` moves them).
3. `bun $Q --repo <repo> --update-baseline`. The baseline lives in the main checkout, shared by worktrees. Without it the gate compares against `project.base` and says so. Run it again after updating the skill.
4. `bun $Q install-hooks <repo>`. Existing hooks (husky, Git LFS) are chained, see [references/hook-chain.md](references/hook-chain.md).
5. Optional: Stop hooks for Claude Code, Codex and pi, [adapters/ENABLE.md](adapters/ENABLE.md).

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
| `cov/diff` | added executable lines covered below `diff_coverage` (blocks in the full gate and `pre-push`) |
| `tamper/*` | deleted or skipped test, weakened assertion, baseline or guarded config changed with code, no tests ran |
| `deps/cycle`, `dead/*`, `dup/jscpd`, `ast/*` | new cycle, new unused export, new clone, empty catch, catch that only logs, textual test |
| `secret/*`, `secret/gitleaks`, `deps/audit`, `deps/lock-age` | tokens and keys, history secrets, new vulnerability, too-young lock entry |
| `doc/*`, `glossary`, `commit/attribution` | dead path or symbol in docs, banned word, AI attribution in a commit |

Notes only: `tamper/mock-added`, `deps/new-package`, `crap/mean`, `security/semgrep`, every `note: jev`. A missing tool prints one `not run` line with the install command and never changes the exit code.

Full rule table with how each one works: [references/checks.md](references/checks.md). Languages and adapters: [references/languages.md](references/languages.md).

## Bypasses

Every bypass needs a reason and leaves a `note: bypass <rule> <source> <reason>` line in the report.

- Deleting a test block: `qg:test-removed <reason>` in the commit message (or in `<out_dir>/allow.md` for `check --staged` and Stop).
- `pre-push` with no test found: `qg:no-test <reason>` in a pushed commit message.
- A deliberate secret in a fixture: `qg:allow <reason>` or `gitleaks:allow <reason>` on the line.
- Changing `src`, thresholds, `[security]`, `[hooks]`, `[review]`, `[knip]`, `[layers]`, `[docs]`, `[glossary] allow` together with source code is blocked; change them in a separate commit.

## Jev

An optional classifier for added test hunks: five yes/no questions with a calibrated probability, notes only, `[review] jev = true` plus a key: `TYPESAFE_API_KEY` for the TypeSafe API or `OPENROUTER_API_KEY` for OpenRouter, picked by `[review] jev_provider` (default `auto`). Details: [references/jev.md](references/jev.md).

## Common mistakes

- Reading `GATE PASS` as "tests green": a fast entry point never runs tests. Check the `tests:` line.
- Judging the mean CRAP: it is a note. What blocks is changed functions and ratchet findings.
- A partial `git add -p`: `pre-commit` refuses a file that also has unstaged edits. Stage it whole.
- husky in `npm install` rewrites `core.hooksPath`: run `install-hooks` again after installing dependencies.
- Skipping `--update-baseline` after updating the skill: the new adapter lists do not block until then.
- Updating the baseline in the same commit as code: `tamper/baseline-touched` blocks it by design.

More limits: [references/limits.md](references/limits.md). Report layout: [references/report.md](references/report.md). Measured noise on real repos: [references/measurements.md](references/measurements.md). Evaluation against sabotages: [references/evaluation.md](references/evaluation.md).
