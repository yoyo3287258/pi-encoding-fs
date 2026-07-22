// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations } from "./operations";
import { createEncodingGrepDefinition } from "./grep";
import { clearConfigCache } from "./config";

// Always-on note (~90 tokens). Kept short so it doesn't dilute the LLM's
// attention; cached after the first turn so marginal cost is near zero.
// Covers both cases in one constant: when a config exists (don't manually
// re-encode / corrupts on-disk) and when one doesn't (create it on garbled
// Chinese). No runtime branch -> stable prompt prefix, cache-friendly.
const ENCODING_NOTE = `Note: \`read\`/\`write\`/\`edit\`/\`grep\` auto-transcode GB18030/GBK ↔ UTF-8 where a \`.encoding-converter.json\` exists (nearest wins; deeper overrides). Don't \`iconv\` or re-save as UTF-8 — that corrupts on-disk encoding. If \`read\` shows garbled Chinese, create/edit \`.encoding-converter.json\`:
{"sourceEncoding":"GB18030","overrides":[{"pattern":"legacy/**","sourceEncoding":"GBK"}]}`;

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Override built-in read/write/edit with encoding-aware operations.
  // No renderCall/renderResult -> inherit built-in rendering (diff/highlight/line numbers).
  pi.registerTool(createReadToolDefinition(cwd, { operations: makeReadOperations() }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: makeWriteOperations() }));
  pi.registerTool(createEditToolDefinition(cwd, { operations: makeEditOperations() }));

  // grep: self-implemented (built-in GrepOperations cannot search GB content).
  pi.registerTool(createEncodingGrepDefinition(cwd));

  // Config is cached per-directory; clear on session start and reload.
  pi.on("session_start", async () => {
    clearConfigCache();
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason === "reload") clearConfigCache();
  });

  // Always append the encoding note. Constant content keeps the prompt prefix
  // stable, so prompt caching stays effective across turns.
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + ENCODING_NOTE };
  });
}
