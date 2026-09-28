import { flagResult, stopNote } from "./invoke.ts";

// Advice only: a hook bypass gets a red flag on the command's result, the Stop report waits for the
// next turn. Nothing blocks a tool call or continues the session.
export default function (omp: any) {
  omp.on("tool_result", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return;
    return await flagResult(ctx.cwd, event.input, event.content);
  });
  omp.on("session_stop", async (event: any, ctx: any) => {
    const note = await stopNote(ctx.cwd, event.session_id);
    if (note) omp.sendMessage({ customType: "code-quality-report", content: note, display: false }, { deliverAs: "nextTurn" });
  });
}
