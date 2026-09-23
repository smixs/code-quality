import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hookFile = () => join(resolve(process.env.GROK_HOME || join(homedir(), ".grok")), "hooks", "code-quality.json");
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function installGrokHooks() {
  const file = hookFile();
  const script = resolve(import.meta.dir, "../quality.ts");
  const command = (action: string) => `bun ${shellQuote(script)} ${action}`;
  const content = JSON.stringify({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: command("agent-stop"), timeout: 300, statusMessage: "Checking code quality" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: command("guard-bash"), timeout: 30, statusMessage: "Checking git hook bypass" }] }],
  } }, null, 2) + "\n";
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content);
  console.log(file);
}

export function uninstallGrokHooks() {
  const file = hookFile();
  if (existsSync(file)) unlinkSync(file);
  console.log(file);
}
