// Translate a shell tool call into the shared PreToolUse decision. This scans direct git commands;
// it intentionally does not claim to interpret shell substitutions or wrapper scripts.
import { readFileSync } from "node:fs";
import { type Args, loadToml, repoConfigFile } from "./config.ts";
import { run } from "./util.ts";

type Word = { value: string; quoted: boolean };

function commands(source: string): Word[][] {
  const result: Word[][] = [];
  let command: Word[] = [];
  let word = "";
  let quote = "";
  let quoted = false;
  let active = false;
  const endWord = () => {
    if (active) command.push({ value: word, quoted });
    word = "";
    quoted = false;
    active = false;
  };
  const endCommand = () => {
    endWord();
    if (command.length) result.push(command);
    command = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\" && quote !== "'") {
      active = true;
      word += source[++i] ?? "";
    } else if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
      active = true;
    } else if (c === "#" && !active) {
      while (i < source.length && source[i] !== "\n") i++;
      endCommand();
    } else if (/\s/.test(c)) {
      if (c === "\n") endCommand();
      else endWord();
    } else if (/[;&|()]/.test(c)) {
      endCommand();
    } else {
      word += c;
      active = true;
    }
  }
  endCommand();
  return result;
}

const gitToken = (value: string) => value === "git" || value.endsWith("/git");
const hookPath = (value: string) => /^core\.hooksPath(?:=|$)/i.test(value);
const assignment = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);

export function bypassReason(source: string): string {
  for (const words of commands(source)) {
    const first = words.findIndex((word) => !assignment(word.value));
    const gitIndex = words.findIndex((word, i) => gitToken(word.value) && (i === first || (first >= 0 && ["env", "command", "exec", "sudo"].includes(words[first].value))));
    if (gitIndex < 0) continue;
    const args = words.slice(gitIndex + 1).map((word) => word.value);
    let subcommand = "";
    let start = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-c" || arg === "--config") {
        if (hookPath(args[i + 1] ?? "")) return "git -c core.hooksPath changes the configured hooks";
        i++;
      } else if ((arg.startsWith("-c") && arg !== "-c" && hookPath(arg.slice(2))) || /^--config=core\.hooksPath(?:=|$)/i.test(arg)) {
        return "git -c core.hooksPath changes the configured hooks";
      } else if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
        i++;
      } else if (!arg.startsWith("-")) {
        subcommand = arg;
        start = i + 1;
        break;
      }
    }
    if (subcommand === "config") {
      const rest = args.slice(start);
      if (rest.some(hookPath)) return "git config core.hooksPath changes the configured hooks";
    }
    if (subcommand !== "commit" && subcommand !== "push") continue;
    const rest = args.slice(start);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--") break;
      if (["-m", "--message", "-F", "--file", "-t", "--template", "-c", "-C", "--reedit-message", "--reuse-message"].includes(arg)) { i++; continue; }
      if (/^(?:--message|--file|--template|--reedit-message|--reuse-message)=/.test(arg) || /^-[mFtcC].+/.test(arg)) continue;
      if (arg === "--no-verify" || (subcommand === "commit" && arg === "-n")) return `git ${subcommand} ${arg} skips verification hooks`;
      if (subcommand === "commit" && /^-[^-]/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === "n") return `git commit ${arg} skips verification hooks`;
          if ("mFtcC".includes(flag)) break;
        }
      }
    }
  }
  return "";
}

export function guardBash(_args: Args) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input.tool_input?.command ?? input.toolInput?.command ?? input.tool_input?.cmd ?? input.toolInput?.cmd;
  const cwd = input.cwd ?? process.cwd();
  const tool = input.tool_name ?? input.toolName ?? "Bash";
  if (typeof command !== "string" || !["Bash", "run_terminal_command", "bash", "exec_command"].includes(tool)) {
    console.log("{}");
    return;
  }
  const top = run("git", ["rev-parse", "--show-toplevel"], cwd);
  const config = top.code === 0 ? repoConfigFile(top.out.trim()) : "";
  if (!config) { console.log("{}"); return; }
  const enabled = loadToml(config).hooks.block_bypass;
  const reason = enabled ? bypassReason(command) : "";
  if (!reason) { console.log("{}"); return; }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  console.error(`code-quality: ${reason}`);
  process.exit(2);
}
