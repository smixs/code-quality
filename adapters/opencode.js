import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/quality.ts", import.meta.url));
const skill = fileURLToPath(new URL("../skills/code-quality/SKILL.md", import.meta.url));
const skillDir = fileURLToPath(new URL("../skills", import.meta.url));

function invoke(action, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [script, action], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try { resolve({ code, result: JSON.parse(out) }); }
      catch { reject(new Error(`code-quality ${action} failed: ${err || out}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function guard(input, cwd) {
  const response = await invoke("guard-bash", { cwd, tool_name: "bash", tool_input: input }, cwd);
  const reason = response.result?.hookSpecificOutput?.permissionDecisionReason;
  if (reason) throw new Error(reason);
  if (response.code !== 0) throw new Error("code-quality guard failed");
}

async function stop(cwd, sessionID) {
  const response = await invoke("agent-stop", { cwd, session_id: sessionID }, cwd);
  if (response.code !== 0) throw new Error("code-quality Stop failed");
  return response.result?.decision === "block" ? response.result.reason : "";
}

const v1 = {
  async server(ctx) {
    const cwd = ctx?.directory ?? process.cwd();
    return {
      config: async (config) => { config.skills = [...new Set([...(config.skills ?? []), skillDir])]; },
      "tool.execute.before": async (input, output) => {
        if (input.tool === "bash") await guard(output.args, input.directory ?? cwd);
      },
      event: async ({ event }) => {
        if (event.type !== "session.idle") return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;
        const reason = await stop(cwd, sessionID);
        if (reason) {
          if (!ctx?.client?.session?.prompt) throw new Error("OpenCode V1 session client is unavailable");
          await ctx.client.session.prompt({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text: reason }] } });
        }
      },
    };
  },
};

// V2 loads @opencode/plugin itself; V1 installations need no V2 dependency to parse this package.
let Plugin;
try { ({ Plugin } = await import("@opencode/plugin")); }
catch { Plugin = { define: (definition) => definition }; }

export default {
  ...Plugin.define({
    id: "code-quality",
    async setup(ctx) {
      const cwd = ctx.location.directory;
      const raw = readFileSync(skill, "utf8");
      const description = /^description:\s*["']?(.+?)["']?$/m.exec(raw)?.[1] ?? "Quality gate for a repo";
      const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      await ctx.skill.transform((editor) => {
        editor.add({ id: "code-quality", name: "code-quality", description, location: skill, content });
      });
      await ctx.tool.hook("execute.before", async (event) => {
        if (event.tool === "bash") await guard(event.input, cwd);
      });
      const controller = new AbortController();
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.idle") continue;
          const sessionID = event.properties?.sessionID;
          if (!sessionID) continue;
          const reason = await stop(cwd, sessionID);
          if (reason) await ctx.session.synthetic({ sessionID, text: reason, resume: false });
        }
      })().catch((error) => console.error(`code-quality: ${error.message}`));
      return () => controller.abort();
    },
  }),
  ...v1,
};
