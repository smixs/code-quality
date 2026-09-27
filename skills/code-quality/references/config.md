# .quality.toml

Sections and keys (defaults in `scripts/lib/config.ts`, `DEFAULTS`):

- `[project]` `language` (a string, a list of `ts`, `py`, `go`, `rust`, `java`, `kotlin`, `csharp`,
  `swift`, `php`, `ruby`, `cpp`, `dart`, or empty = auto over all manifests), `src` (folders), `base`
  (the ref for "the change"; empty by default = detected from `refs/remotes/origin/HEAD`, then
  `origin/main`, `origin/master`, `main`, and the report header marks a detected base with
  `(detected)`), `test_cmd` (the full gate; it must write lcov to `$QG_LCOV`, with `$QG_DIR` =
  `out_dir`; `$QG_LCOV` starts empty, and the command and the tests' child processes append to it), `out_dir` (every report, the baseline, `allow.md`, the Stop markers, `jev-log.jsonl`;
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
  (at most 40 test files per push). For TS/JS the pre-push selection is names plus direct relative
  imports, `require` and aliases from the root `tsconfig.json` `compilerOptions.paths`.
  `check --tests` and `mutant` select the closure: every test that reaches a changed file through any
  chain of imports, `export … from`, dynamic imports and `require`, plus a quoted string in a test file
  that resolves from the test's folder to a tracked file (`runHarness(resolve(import.meta.dir,
  "ThemePanel.render-harness.tsx"))`); so test -> harness -> screen -> barrel -> panel -> component ->
  util is found. A test beside the source named `<stem>.<anything>.test.<ext>` is a named test
  (`ThemePanel.render.test.ts` for `ThemePanel.tsx`). The report counts by name, by direct import and
  further. A module specifier resolves, in order: a relative path; a `#…` specifier through the
  `imports` of the nearest tracked `package.json` at or above the importing file's folder (targets, a
  string or the `import` / `default` of a condition object, from that `package.json`'s folder); the
  `paths` of the nearest `tsconfig.json` at or above that folder (a config without `paths` takes them
  through a relative `extends`; targets resolve against the `baseUrl` of the config that declares
  `paths`, else its folder); a workspace package (a tracked `package.json` outside `node_modules` with a
  `name`: the bare name goes to `exports` as a string or `exports["."]` as a string or its `import` /
  `default`, else `module`, else `main`, else `src/index`; `name/sub` goes to `<package>/<sub>` or
  `<package>/src/<sub>`). In `imports` and `paths` an exact key wins, else the `*` pattern with the
  longest prefix before `*`, and only that key's targets are tried, in their order. Extensions and
  `/index` as for a relative import; anything else is external. Files in `node_modules` are not part of
  the chain.
- `[tests]` - test runs the gate starts. `touched_cmd` - the coverage command of `check --tests`, must
  contain `{files}` (the touched test list, shell-quoted) and write lcov to `$QG_LCOV` (`$QG_DIR` = its
  private run directory; `$QG_LCOV` starts empty, and the command and the tests' child processes append
  to it; the built-in commands write the runner's report under `$QG_DIR` and append it, keeping the
  tests' exit code); without it `project.test_cmd` is used when it contains `{files}`, else the
  adapter's file-aware command (node, bun, vitest, pytest; `note: tests/touched: project.test_cmd has no
  {files}` when a `test_cmd` without `{files}` is set). Other languages run their full coverage command
  with `note: tests/touched not supported for <lang>`. `mutant_cmd` - the test command of `mutant`, must
  contain `{files}` and print a node, bun, vitest or pytest summary; the default is the adapter's
  file-aware test command (`node --test {files}`, `bun test {files}`, `npx vitest run {files}`,
  `uv run --with pytest pytest -q {files}`), other languages need it set. The TS/JS runner: `vitest` in
  `package.json` -> vitest; else `bun.lock` or `bun.lockb` at the repo root -> bun; else node (no
  `package.json` -> bun). `max_load` (default: twice the CPU
  count, since a shared machine idles near its CPU count; `0` = no wait) and `load_wait_s` (600): before every test run (full gate, `check --tests`,
  pre-push, `mutant`) the gate waits while the 1-minute load average is above `max_load`, polling every
  10 s up to `load_wait_s`, then runs anyway with `note: tests/load ran at load X.X after Ns`.
  `touched_timeout_s` (900) - `check --tests`; `mutant_timeout_s` (300) - each of the two `mutant`
  runs. A timeout kills the run's whole process group. `[hooks] pre_push_timeout` still bounds pre-push.
  The environment variable `QG_TEST_LOADAVG` replaces the load reading; it exists for the gate's own
  tests only.
- `[review]` `jev` (default `false`), `jev_provider` (`auto` | `typesafe` | `openrouter` | `custom`;
  `auto` = TypeSafe when `TYPESAFE_API_KEY` is set, else OpenRouter when `OPENROUTER_API_KEY` is set),
  `jev_url`, `jev_key_env`, `jev_model` (empty = the default of the chosen provider:
  `https://api.typesafe.ai/v1/systemone` + `TYPESAFE_API_KEY` + `jev-1.13.0`, or
  `https://openrouter.ai/api/alpha/decisions` + `OPENROUTER_API_KEY` +
  `typesafe/jev-1.13-20260917`; `custom` needs all three), `jev_max_states`
  (12); switches `textual_test`, `error_path_tested`, `assertion_weakened`, `mock_hides_behavior`,
  `property_is_tautology` (all `true` by default); thresholds `textual_test_threshold` (0.85),
  `error_path_tested_threshold` (0.5), `assertion_weakened_threshold`, `mock_hides_behavior_threshold`,
  `property_tautology_threshold` (the last three at 0.7). `change_untested` (`true`) with
  `change_untested_threshold` (0.5, a note below it). `spec` - the task spec for `spec_incomplete`, a
  path relative to the repo (`spec = "docs/specs/task.md"`); empty = the path in `$QG_SPEC`; neither
  = one `jev: spec not set ([review] spec or QG_SPEC)` line and no spec question; `spec_incomplete`
  (`true`) with `spec_incomplete_threshold` (0.7). The UX pack: `ux_globs` and `i18n_globs` (globs of
  interface files and of text dictionaries, both empty = off), `ux_off` (question ids to skip),
  `ux_threshold` (0.7). The agent pack: `agent_globs` and `agent_prompt_globs` (globs of agent code
  and of prompts or instructions, both empty = off), `agent_off`, `agent_threshold` (0.7). Project
  questions: `[[review.jev_questions]]` tables with `id`, `files`, `trigger`, `instructions`,
  `criteria = { true = "...", false = "..." }`, `note`, optional `threshold` (0.7) and `below`
  (see the Jev reference). `llm` is not wired yet, `true` gives one `note:` line.
  Reviewers never block.

The list of guarded keys and the rule for changing them together with sources is in
"Bypasses and their trace".

## Git hooks


`install-hooks <repo>` writes a stable `core.hooksPath` under `~/.local/share/code-quality/git-hooks/` (override with `CODE_QUALITY_HOME`). Its `hooks-root` names the plugin copy the hooks run: the newest copy an agent invoked on this machine through `agent-stop` or `guard-bash`, or the last one when that copy is gone (`root`). Only those two entry points and `install-hooks` write `root` and `hooks-root`; a copy run by hand (`check`, `mutant`, the full gate, `hook ...`) leaves both alone. The repo's own hooks (Git LFS, husky, anything else) keep working: every wrapper calls the previous hook with the same arguments and returns its exit code. `uninstall-hooks <repo>` puts the old value back. `[hooks] block_bypass = false` disables the agent shell guard; the default is `true`.

## Stop hooks

The git hooks catch commits. The Stop hooks catch the state before a commit: when the agent ends a turn, the adapter runs `check` and answers with the hook contract.

- Claude Code: one more group in `hooks.Stop` of `~/.claude/settings.json`;
- Codex: one more group in `hooks.Stop` of `~/.codex/hooks.json`, then trust it through `/hooks`;
- pi: an extension on `agent_settled`, one follow-up message per chain.

A red gate returns `{"decision": "block", "reason": ...}` and the agent gets one round of fixes. The same red verdict a second time in the same session returns a `systemMessage` instead of another block, so the loop is bounded. Plugin hook definitions are in [hooks/hooks.json](../../../hooks/hooks.json).
