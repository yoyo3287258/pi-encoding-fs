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
}
