# Enable the agent Stop adapters

The adapters hold no logic. Each one calls `scripts/quality.ts agent-stop`, which reads the hook JSON
on stdin and prints the answer. A repo without `.quality.toml` is skipped (`{}`), so an adapter can be
enabled globally: it only fires where a project is wired in.

What `agent-stop` does (the Stop contract of Claude Code and Codex is the same, checked against
code.claude.com/docs/en/hooks and learn.chatgpt.com/docs/hooks on 18.09.2026):

- input: `{"cwd": "...", "session_id": "...", ...}`; no JSON on stdin = error on stderr and exit 1
  (not 2: in Claude Code exit 2 means "block", and a broken call would lock the agent in);
- the session touched nothing (`[project] src` paths clean in `git status` and HEAD unchanged since the
  last Stop of this session, `<out_dir>/stop-heads.json`, `out_dir` default `.scratch/quality`): `{}` right away, the gate does not
  run. The first Stop of a session on a clean tree only remembers HEAD: commits before it passed
  pre-commit;
- gate green or repo not wired: `{}`, the agent finishes;
- gate red: `{"decision": "block", "reason": "<verdict and report path>"}`, the agent keeps going and fixes it;
- the same red verdict in the same session a second time: `{"systemMessage": "..."}` with no block. One
  round of fixes per new red verdict. The script counts rounds itself (`<out_dir>/stop-block.json`)
  instead of using `stop_hook_active`: that flag is true when another Stop hook blocked too, and the
  gate would stay silent. The key of "the same verdict" is the session id plus the deterministic red
  lines only (`GATE FAIL ...` and findings). `note: jev ...`, `jev: not available (...)`, the tests line
  and the report path are not part of the key: a timeout or a different Jev answer between two Stops is
  not a new verdict and does not block the agent a second time (test `a Jev note that changes between
  two Stops ...`). Codex has no limit of its own, Claude Code has one (8 blocks in a row).

The check is `check`: the change against `project.base` plus uncommitted work; lcov is used only when
fresh, otherwise complexity only. Time on a mid-size TypeScript repo: about 10-20 s.

## Claude Code

File `~/.claude/settings.json`: add one more group to the `hooks.Stop` array (keep the Stop hooks you
already have):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/skills/code-quality/adapters/claude-stop.sh",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

Check it after enabling: in a wired repo leave a function with complexity 11 and ask the agent to
finish. Expect a `Stop hook` message with `Quality gate is red ...` in it.

## Codex

File `~/.codex/hooks.json`: add a group to the `hooks.Stop` array (keep the Stop hooks you already
have):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/skills/code-quality/adapters/codex-stop.sh",
            "timeout": 300,
            "statusMessage": "quality gate"
          }
        ]
      }
    ]
  }
}
```

Then open `/hooks` in the Codex CLI and trust the new hook (Codex stores trust by the hash of the
definition in `[hooks.state]` of `~/.codex/config.toml`; without that the hook is skipped silently).
Hooks are on by default; `[features] hooks = false` turns them off.

## pi

pi has no Stop hook. The closest event is `agent_settled` in the extension API (pi-mono
`packages/coding-agent/docs/extensions.md`): pi itself will not continue. On that event the adapter
`pi-code-quality.ts` pipes the same JSON through `agent-stop` and, on `decision: "block"`, sends the
reason to the agent as a follow-up message, once per chain.

To enable it, copy (or symlink) the file into the pi extension autoload folder and reload pi:

```bash
ln -s ~/.claude/skills/code-quality/adapters/pi-code-quality.ts ~/.pi/agent/extensions/code-quality.ts
# in the pi panel: /reload
```

The adapter has not been tested live in pi (editing `~/.pi` was out of scope). Only this much was
verified: the same call `sh -c 'printf "%s" "$1" | exec bun quality.ts agent-stop'` returns `block`
on a red scratch repo.

## Turn it off

Remove the added group from `settings.json` / `hooks.json`, delete the symlink in
`~/.pi/agent/extensions/`. Repo git hooks are removed separately:
`bun ~/.claude/skills/code-quality/scripts/quality.ts uninstall-hooks <repo>`.
