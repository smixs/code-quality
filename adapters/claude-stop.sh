#!/bin/sh
# Claude Code Stop hook. No logic here: the shared script reads the hook JSON on stdin and prints
# {} (allow) or {"decision":"block","reason":...}. Repos without .quality.toml are skipped.
exec bun "$(dirname "$0")/../scripts/quality.ts" agent-stop
