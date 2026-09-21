#!/bin/sh
# Codex Stop hook. Same JSON contract as Claude Code (stdin {cwd, session_id, ...};
# stdout {} or {"decision":"block","reason":...}), so it calls the same entry point.
exec bun "$(dirname "$0")/../scripts/quality.ts" agent-stop
