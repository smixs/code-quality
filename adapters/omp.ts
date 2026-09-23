import { denied, invoke } from "./invoke.ts";

export default function (omp: any) {
  omp.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return;
    const result = await invoke("guard-bash", { cwd: ctx.cwd, tool_name: "bash", tool_input: event.input }, ctx.cwd);
    const reason = denied(result);
    if (reason) return { block: true, reason };
  });
  omp.on("session_stop", async (event: any, ctx: any) => {
    const result = await invoke("agent-stop", { cwd: ctx.cwd, session_id: event.session_id }, ctx.cwd);
    if (result.output?.decision === "block") return { decision: "block", reason: result.output.reason };
    if (result.code !== 0 || !result.output) return { decision: "block", reason: `code-quality Stop failed: ${result.error}` };
  });
}
