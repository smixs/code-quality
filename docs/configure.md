# Configure

## `.quality.toml`

A minimal config in the repo root:

```toml
[project]
language = "ts"
src = ["src"]
base = "origin/main"
test_cmd = 'node --test --test-reporter=lcov --test-reporter-destination="$QG_LCOV" "src/**/*.test.ts"'

[thresholds]
max_cc = 10
max_crap = 30
diff_coverage = 0.8

[docs]
globs = ["README.md", "docs/**/*.md"]

[secrets]
allow_users = ["deploy"]
```

`test_cmd` runs in the full gate and must write lcov to `$QG_LCOV`. An unknown key is an error that names the key. Keys that could narrow the gate (`src`, thresholds, bypass settings) are protected from changes in the same commit as source code.

Full examples with every key: [typescript.quality.toml](../examples/typescript.quality.toml), [python.quality.toml](../examples/python.quality.toml). The key reference is in [SKILL.md](../SKILL.md).

## Git hooks

`install-hooks <repo>` writes `core.hooksPath` into the repo's `.git/config`. The repo's own hooks (Git LFS, husky, anything else) keep working: every wrapper calls the previous hook with the same arguments and returns its exit code. `uninstall-hooks <repo>` puts the old value back.

## Stop hooks

The git hooks catch commits. The Stop hooks catch the state before a commit: when the agent ends a turn, the adapter runs `check` and answers with the hook contract.

- Claude Code: one more group in `hooks.Stop` of `~/.claude/settings.json`;
- Codex: one more group in `hooks.Stop` of `~/.codex/hooks.json`, then trust it through `/hooks`;
- pi: an extension on `agent_settled`, one follow-up message per chain.

A red gate returns `{"decision": "block", "reason": ...}` and the agent gets one round of fixes. The same red verdict a second time in the same session returns a `systemMessage` instead of another block, so the loop is bounded. Snippets: [adapters/ENABLE.md](../adapters/ENABLE.md).
