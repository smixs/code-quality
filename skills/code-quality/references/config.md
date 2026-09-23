# .quality.toml

Sections and keys (defaults in `scripts/lib/config.ts`, `DEFAULTS`):

- `[project]` `language` (a string, a list of `ts`, `py`, `go`, `rust`, `java`, `kotlin`, `csharp`,
  `swift`, `php`, `ruby`, `cpp`, `dart`, or empty = auto over all manifests), `src` (folders), `base`
  (the ref for "the change"; empty by default = detected from `refs/remotes/origin/HEAD`, then
  `origin/main`, `origin/master`, `main`, and the report header marks a detected base with
  `(detected)`), `test_cmd` (the full gate; it must write lcov to `$QG_LCOV`, with `$QG_DIR` =
  `out_dir`), `out_dir` (every report, the baseline, `allow.md`, the Stop markers, `jev-log.jsonl`;
  default `.scratch/quality`), `tools_dir` (cache for the npm tools the gate installs itself;
  `QG_TOOLS` wins over it, the default is `~/.cache/quality-gate`, on Windows
  `%LOCALAPPDATA%/quality-gate`).
- `[thresholds]` see "Thresholds", including the warning `max_mean_crap`, `diff_coverage = 0.8` and
  `min_release_age_days = 1`.
- `[layers] forbid = ["^agent/:^scripts/"]` - path regexes from:to.
- `[knip] ignore` - globs.
- `[glossary] path`, `marker` (`_Avoid_:`), `allow`, `globs`, `commit_msg`.
- `[docs] globs` - files whose links must resolve; `history_globs` (default `docs/adr/**`,
  `CHANGELOG.md`) - history: it names deleted files and symbols, those files are not checked.
- `[secrets] allow_users` - home folder names that are not a developer machine.
- `[security] gitleaks`, `audit` - switches for Gitleaks and the dependency audit; both `true` by
  default. `registry_urls` - the URL template per ecosystem for `deps/lock-age`
  (`npm`, `pypi`, `crates`, `go`, `rubygems`, `packagist`, `pub`, `nuget`, `maven`, `deps.dev`),
  for a mirror: `registry_urls = { npm = "https://mirror.local/npm/{name}" }`. `{name}`, `{version}`,
  `{system}`, `{group}` and `{artifact}` are filled in. An empty value means the ecosystem has no
  registry: `deps/lock-age: not checked (no registry for <ecosystem>)`, never a block. An unknown
  ecosystem is a config error.
- `[escalate] paths` - path globs for "always to the reviewer".
- `[tools]` - one entry per external tool, the id from `scripts/lib/tools.ts`
  (`dependency-cruiser`, `typescript`, `knip`, `jscpd`, `eslint`, `typescript-eslint-parser`,
  `eslint-plugin-sonarjs`, `ast-grep`, `lizard`, `radon`, `gitleaks`, `osv-scanner`, `semgrep`,
  `node`, `go`, `gcov2lcov`, `deadcode`, `gocyclo`, `pmd`, `detekt`, `xccov2lcov`, `periphery`,
  `swiftlint`, `include-what-you-use`, `clang-tidy`, `reportgenerator`). A bare value is a version
  (`jscpd = "5.3.0"`), a value with a path separator a binary path
  (`gitleaks = "/opt/bin/gitleaks"`). An unknown id is a config error naming the key. The install
  hint in a `not run:` line follows `process.platform`, so a Linux hint never says `brew`.
- `[hooks] pre_push_test_cmd` (`{files}` = the test list; the default comes from the language
  adapter: `node --test {files}`, for Python `uv run --with pytest pytest -q {files}`), `pre_push_timeout` (seconds), `pre_push_max_tests`
  (at most 40 test files per push). For TS/JS the selection includes direct relative imports,
  `require` and aliases from `tsconfig.json` `compilerOptions.paths`; dependency depth is one import.
- `[review]` `jev` (default `false`), `jev_provider` (`auto` | `typesafe` | `openrouter` | `custom`;
  `auto` = TypeSafe when `TYPESAFE_API_KEY` is set, else OpenRouter when `OPENROUTER_API_KEY` is set),
  `jev_url`, `jev_key_env`, `jev_model` (empty = the default of the chosen provider:
  `https://api.typesafe.ai/v1/systemone` + `TYPESAFE_API_KEY` + `jev-1.13.0`, or
  `https://openrouter.ai/api/alpha/decisions` + `OPENROUTER_API_KEY` +
  `typesafe/jev-1.13-20260917`; `custom` needs all three), `jev_max_states`
  (12); switches `textual_test`, `error_path_tested`, `assertion_weakened`, `mock_hides_behavior`,
  `property_is_tautology` (all `true` by default); thresholds `textual_test_threshold` (0.85),
  `error_path_tested_threshold` (0.5), `assertion_weakened_threshold`, `mock_hides_behavior_threshold`,
  `property_tautology_threshold` (the last three at 0.7). `llm` is not wired yet, `true` gives one
  `note:` line.
  Reviewers never block.

The list of guarded keys and the rule for changing them together with sources is in
"Bypasses and their trace".

## Git hooks


`install-hooks <repo>` writes a stable `core.hooksPath` under `~/.local/share/code-quality/git-hooks/` (override with `CODE_QUALITY_HOME`). A root pointer in that directory follows the currently loaded plugin version. The repo's own hooks (Git LFS, husky, anything else) keep working: every wrapper calls the previous hook with the same arguments and returns its exit code. `uninstall-hooks <repo>` puts the old value back. `[hooks] block_bypass = false` disables the agent shell guard; the default is `true`.

## Stop hooks

The git hooks catch commits. The Stop hooks catch the state before a commit: when the agent ends a turn, the adapter runs `check` and answers with the hook contract.

- Claude Code: one more group in `hooks.Stop` of `~/.claude/settings.json`;
- Codex: one more group in `hooks.Stop` of `~/.codex/hooks.json`, then trust it through `/hooks`;
- pi: an extension on `agent_settled`, one follow-up message per chain.

A red gate returns `{"decision": "block", "reason": ...}` and the agent gets one round of fixes. The same red verdict a second time in the same session returns a `systemMessage` instead of another block, so the loop is bounded. Plugin hook definitions are in [hooks/hooks.json](../../../hooks/hooks.json).
