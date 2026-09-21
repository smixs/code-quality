// pi has no Stop hook contract; the equivalent is an extension on `agent_settled`.
// No gate logic here: it pipes the same Stop JSON into quality.ts agent-stop and, on
// {"decision":"block"}, sends the reason back as a follow-up user message (once per chain).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";

const SCRIPT = join(homedir(), ".claude/skills/code-quality/scripts/quality.ts");

export default function (pi: ExtensionAPI) {
  // The script allows one block per red verdict per session; this id keys that session.
  const session = `pi-${process.pid}-${Date.now()}`;
  pi.on("agent_settled", async (_event, ctx) => {
    const input = JSON.stringify({ cwd: ctx.cwd, session_id: session });
    const r = await pi.exec("sh", ["-c", 'printf "%s" "$1" | exec bun "$2" agent-stop', "sh", input, SCRIPT], { timeout: 600_000 });
    // No output means the script failed: say so, do not read it as "allow".
    if (!r.stdout.trim()) return ctx.ui.notify(`quality gate failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`, "error");
    let out: { decision?: string; reason?: string; systemMessage?: string };
    try {
      out = JSON.parse(r.stdout);
    } catch (e) {
      return ctx.ui.notify(`quality gate returned non-JSON (exit ${r.code}, ${(e as Error).message}): ${r.stdout.slice(0, 300)}`, "error");
    }
    if (out.decision === "block") pi.sendUserMessage(out.reason, { deliverAs: "followUp" });
    else if (out.systemMessage) ctx.ui.notify(out.systemMessage, "warning");
  });
}
