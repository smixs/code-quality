import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { denied, invoke } from "./invoke.ts";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const result = await invoke("guard-bash", { cwd: ctx.cwd, tool_name: "bash", tool_input: event.input }, ctx.cwd);
    const reason = denied(result);
    if (reason) return { block: true, reason };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const result = await invoke("agent-stop", { cwd: ctx.cwd, session_id: session }, ctx.cwd);
    const reason = result.output?.decision === "block" ? result.output.reason
      : result.code !== 0 || !result.output ? `code-quality Stop failed: ${result.error}` : "";
    if (!reason) return;
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "code-quality-retry", content: reason, display: false }],
      continue: true,
    };
  });
}
