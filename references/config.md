# .quality.toml

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

## Git hooks


`install-hooks <repo>` writes `core.hooksPath` into the repo's `.git/config`. The repo's own hooks (Git LFS, husky, anything else) keep working: every wrapper calls the previous hook with the same arguments and returns its exit code. `uninstall-hooks <repo>` puts the old value back.

## Stop hooks

The git hooks catch commits. The Stop hooks catch the state before a commit: when the agent ends a turn, the adapter runs `check` and answers with the hook contract.

- Claude Code: one more group in `hooks.Stop` of `~/.claude/settings.json`;
- Codex: one more group in `hooks.Stop` of `~/.codex/hooks.json`, then trust it through `/hooks`;
- pi: an extension on `agent_settled`, one follow-up message per chain.

A red gate returns `{"decision": "block", "reason": ...}` and the agent gets one round of fixes. The same red verdict a second time in the same session returns a `systemMessage` instead of another block, so the loop is bounded. Snippets: [adapters/ENABLE.md](../adapters/ENABLE.md).
