// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations } from "./operations";
import { createEncodingGrepDefinition } from "./grep";
import { wrapEditToolWithEncodingPreview, clearUtf8Cache } from "./edit-preview";
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
  // read/write keep Pi's built-in rendering; edit is special-cased below.
  pi.registerTool(createReadToolDefinition(cwd, { operations: makeReadOperations() }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: makeWriteOperations() }));

  // edit needs more than encoding-aware operations: Pi's `edit` tool reads the
  // file TWICE — once in `execute()` (via our `operations.readFile`, correct)
  // and once in `renderCall()` -> `computeEditsDiff()`, which uses the built-in
  // `readFile(path, "utf-8")` and bypasses our operations entirely. For a
  // GB18030/GBK file that preview reads raw GB bytes as UTF-8 (mojibake),
  // can't match a Chinese oldText, and shows a false red
  // "Could not find the exact text" box during streaming — even though the
  // real edit succeeds. `computeEditsDiff` is not exported and accepts no
  // readFile override, so we wrap the ToolDefinition's `renderCall` to run an
  // encoding-aware preview for non-UTF-8 files and delegate to the upstream
  // renderer for UTF-8 files (zero UX loss). See src/edit-preview.ts.
  const editDef = createEditToolDefinition(cwd, { operations: makeEditOperations() });
  pi.registerTool(wrapEditToolWithEncodingPreview(editDef, makeEditOperations(), cwd));

  // grep: self-implemented (built-in GrepOperations cannot search GB content).
  pi.registerTool(createEncodingGrepDefinition(cwd));

  // Config is cached per-directory; clear on session start and reload.
  pi.on("session_start", async () => {
    clearConfigCache();
    clearUtf8Cache();
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason === "reload") {
      clearConfigCache();
      clearUtf8Cache();
    }
  });

  // Always append the encoding note. Constant content keeps the prompt prefix
  // stable, so prompt caching stays effective across turns.
  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + "\n\n" + ENCODING_NOTE };
  });
}
