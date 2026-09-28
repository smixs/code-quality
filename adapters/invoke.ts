import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const scriptPath = () => fileURLToPath(new URL("../scripts/quality.ts", import.meta.url));

export async function invoke(command: "agent-stop" | "guard-bash", input: object, cwd: string) {
  return new Promise<{ code: number; output: any; error: string }>((resolve) => {
    const child = spawn("bun", [scriptPath(), command], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 2, output: null, error: error.message }));
    child.on("close", (code) => {
      let output: any = null;
      try { output = JSON.parse(stdout); } catch { /* invalid output is an error below */ }
      resolve({ code: code ?? 2, output, error: stderr || (!output ? `invalid ${command} JSON: ${stdout.slice(0, 200)}` : "") });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// Nothing here blocks: a red flag is text for the agent, a failed call is a note, never a denial.
export function flagged(result: Awaited<ReturnType<typeof invoke>>): string {
  return result.output?.hookSpecificOutput?.additionalContext ?? "";
}

// The Stop note, asked for inline so the adapter hands it to its own next-turn channel.
export async function stopNote(cwd: string, session: string) {
  const result = await invoke("agent-stop", { cwd, session_id: session, deliver: "inline" }, cwd);
  if (result.output?.note) return String(result.output.note);
  return result.code !== 0 || !result.output ? `code-quality Stop failed (nothing was held): ${result.error}` : "";
}

// The red flag goes in front of the command's own output, so the agent reads it with the result.
export async function flagResult(cwd: string, input: unknown, content: any[]) {
  const flag = flagged(await invoke("guard-bash", { cwd, tool_name: "bash", tool_input: input }, cwd));
  return flag ? { content: [{ type: "text", text: flag }, ...content] } : undefined;
}
