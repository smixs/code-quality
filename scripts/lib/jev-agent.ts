// The agent pack: questions on faults that recur in AI assistant and agent codebases: failures the
// user never hears about, turns and loops without a limit, secrets in logs, updates without a way
// back, events acted on twice, persistent state overwritten, prompts that depend on the install,
// per-vendor patches, raw text in chat. Asked only on files in [review] agent_globs (code) and
// agent_prompt_globs (prompts and instructions). Each trigger is in code; the question reads the
// hunk as `source_hunk`. Wording is fixed: it is what agent_threshold means.
import { basename } from "node:path";
import { firstLine, type HitContext, type Hunk, lineHit, noul, type PackQ, packQ } from "./jev-hunks.ts";

// ---- triggers

const CATCH = /\bcatch\b|\.catch\(|\btry\s*\{|\?\?\s*null\b/;
const LOOP = /\bwhile\s*\(|\bfor\s+await\b|\bsetInterval\(|\bsetTimeout\(|\bretry|\battempts?\b|\bmaxSteps\b|\bspawn\w*\(/i;
const LOG = /console\.(?:log|error|warn|info|debug)\(|\blog(?:ger)?\.\w+\(|\blog\(|diagnos|telemetry|JSON\.stringify\((?:process\.env|env|headers|auth|message|msg|text|body|prompt)\b/i;
const UPDATE_PATH = /update|upgrade|version|install|systemd|(?:^|\/)bin\//i;
const UPDATE_CODE = /systemd|systemctl|launchctl|\bsymlink(?:Sync)?\(|["'`]\.env["'`]|node_modules|["'`/]versions?\/|\brollback\b|daemon-reload/i;
const EVENT = /\bwebhook|\breplay|\bredeliver|\bretry|update_id|message_id|event_id|delivery_id|\bon(?:Message|Update|Event)\b/i;
const OVERWRITE = /\bwriteFile(?:Sync)?\(|\btruncate|\boverwrite|\bfs\.write\(|\.write\(\s*\w+\s*,\s*["'`]w["'`]|\bopen\([^)]*["'`]w["'`]/;
const PROMPT_REF = /\/[\w.-]+\/|\.(?:md|ts|js|py|sh|json|toml|ya?ml)\b|\b(?:bun|node|npx|bash|python3?|uv)\s|\bskills?\b|\b(?:claude|codex|gpt|ollama|gemini|grok|deepseek|llama|mistral)\b/i;
const PROMPT_CODE = /build\w*Prompt\w*\(|\b(?:prompt|instructions?|system)\w*\s*[=:+]\s*`/i;
const VENDORS = "claude|anthropic|openai|codex|gpt|ollama|gemini|google|grok|xai|deepseek|mistral|openrouter|bedrock|azure";
const VENDOR_BRANCH = new RegExp(`\\b(?:provider|vendor)\\w*\\s*[!=]==|\\bcase\\s+["'\`](?:${VENDORS})["'\`]|[!=]==\\s*["'\`](?:${VENDORS})["'\`]`, "i");
const PROVIDER_FILE = /^(?:providers?|vendors?|models?)\b/i;
const CHAT = /\b(?:send|reply|respond|notify|post)\w*\(|sendMessage|reply_markup|inline_keyboard/;

function promptHit(h: Hunk, c: HitContext) {
  return c.kind(h.file, "prompt") ? firstLine(h, PROMPT_REF) : firstLine(h, PROMPT_CODE);
}

const vendorHit = (h: Hunk) => (PROVIDER_FILE.test(basename(h.file)) ? null : firstLine(h, VENDOR_BRANCH));

const updateHit = (h: Hunk) => firstLine(h, UPDATE_PATH.test(h.file) ? /\S/ : UPDATE_CODE);

// ---- questions

const agent = packQ("agent_threshold");

// on: code = [review] agent_globs, prompt = agent_prompt_globs, both = either.
export const AGENT_QUESTIONS: PackQ[] = [
  agent({ id: "silent_failure", label: "an error on a user-facing path is swallowed; neither the user nor the log learns the cause", on: "code", hit: lineHit(CATCH) }, noul(
    "Does the code added in `source_hunk` catch, swallow or return early on an error on a path whose outcome the user is waiting for (a reply, a delivery, a scheduled or background run), without telling the user or writing a log line that names the cause?",
    "An added catch, early return or null fallback ends a user-facing path on an error, and neither a message to the user nor a log line with the cause is added.",
    "The error reaches the user or a log line that names the cause, or it is rethrown, or no user waits for the outcome of this path.",
  )),
  agent({ id: "unbounded_turn", label: "a turn, job, retry loop or timer has no limit or no cancel path", on: "code", hit: lineHit(LOOP) }, noul(
    "Does the code added in `source_hunk` start a model turn, background job, loop that repeats a failed call, or timer without a bound on steps, tokens or time, or without a way for the user to cancel it?",
    "An added turn, job, retry loop or timer has no limit on steps, tokens or time, or nothing the user's stop or reset can cancel.",
    "Every added turn, job, loop or timer has a limit and a cancel path, or the hunk starts none.",
  )),
  agent({ id: "secrets_in_logs", label: "a log, trace or diagnostic bundle carries a secret or the user's own content", on: "code", hit: lineHit(LOG) }, noul(
    "Does the code added in `source_hunk` write a token, key, environment content, or the user's own content (message text, stored memory, notes) into a log line, diagnostic bundle, error message, trace or telemetry?",
    "An added log, bundle, error or trace carries a secret, environment content, or the text of a user's message or stored content.",
    "Logs and bundles carry only ids, hashes, codes and counts, or the hunk adds no log.",
  )),
  agent({ id: "update_without_rollback", label: "the update or install flow changed without a way back", on: "code", hit: updateHit }, noul(
    "Does the code added in `source_hunk` change the update, install or restart flow (version directories, service units, symlinks, environment files, dependencies) without a rollback path or a check that the previous version still starts if the new one fails?",
    "The update, install or restart flow changes and nothing probes the new version or switches back to the previous one on failure.",
    "The changed flow probes the new version and keeps a working way back, or the hunk does not touch the update flow.",
  )),
  agent({ id: "event_without_dedup", label: "a redelivered or retried event acts twice; no idempotency key", on: "code", hit: lineHit(EVENT) }, noul(
    "Does the code added in `source_hunk` act on an inbound update, a repeated call after a failure, a replayed event or a timer without a key (message id, event id, delivery id) that makes a second delivery of the same event a no-op?",
    "The added handler acts on an event, retry or replay without checking a key that makes a second delivery do nothing.",
    "The handler checks an idempotency key before acting, or its action is harmless when repeated.",
  )),
  agent({ id: "state_overwrite_instead_of_append", label: "persistent state is overwritten instead of appended or merged", on: "code", hit: lineHit(OVERWRITE) }, noul(
    "Does the code added in `source_hunk` replace, truncate or regenerate an existing persistent record that the user or the agent built up over time (memory, notes, history, user-written content) instead of appending or merging into it, or write it without an atomic write?",
    "An added write replaces or truncates an existing record of accumulated content, or writes it in place without an atomic write.",
    "Accumulated records are appended to or merged, written atomically, or the written file holds no accumulated content.",
  )),
  agent({ id: "prompt_depends_on_environment", label: "a prompt points the model at a path, script, skill or model the install may not have", on: "both", hit: promptHit }, noul(
    "Does the instruction or prompt text added in `source_hunk` tell the model to read a file by path, run a script, or rely on a skill, provider or model that the running install may not have, instead of putting the needed text into the prompt itself?",
    "Added prompt text points the model at a file path, a script, a skill, a provider or a model name that it must reach at run time.",
    "The prompt carries the needed text itself or names only tools the model is given, or the hunk adds no prompt text.",
  )),
  agent({ id: "per_vendor_branch", label: "a branch for one provider patches behaviour that every provider needs", on: "code", hit: vendorHit }, noul(
    "Does the code added in `source_hunk` add a branch keyed on one provider, model or vendor for behaviour that every provider needs, instead of one mechanism that works for all of them?",
    "An added if, case or comparison on one provider or vendor name changes behaviour that every provider needs.",
    "The behaviour goes through one mechanism for all providers, or the branch maps a real difference of that provider's API.",
  )),
  agent({ id: "user_text_quality", label: "text sent to the user shows a trace, identifier, path or command, or skips localisation", on: "code", hit: lineHit(CHAT) }, noul(
    "Does the text that the code added in `source_hunk` sends to the user in a chat or message expose a stack trace, internal identifier, file path or shell command, or hard-code the wording instead of passing it through the project's localisation?",
    "An added message to the user carries a trace, an identifier, a path or a command, or is a hard-coded string where the project localises its texts.",
    "Messages to the user are plain words through the project's localisation, or the hunk sends no text to the user.",
  )),
];
