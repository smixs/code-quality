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

export function denied(result: Awaited<ReturnType<typeof invoke>>) {
  return result.output?.hookSpecificOutput?.permissionDecision === "deny"
    ? result.output.hookSpecificOutput.permissionDecisionReason
    : result.code !== 0 ? `code-quality guard failed: ${result.error}` : "";
}
