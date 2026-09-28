import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { flagResult, stopNote } from "./invoke.ts";

// Advice only: a hook bypass gets a red flag on the command's result, the Stop report waits for the
// next turn. Nothing blocks a tool call or continues the turn.
export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    return (await flagResult(ctx.cwd, event.input, event.content)) as any;
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    const note = await stopNote(ctx.cwd, ctx.sessionManager.getSessionId());
    if (note) pi.sendMessage({ customType: "code-quality-report", content: note, display: false }, { deliverAs: "nextTurn" });
  });
}
