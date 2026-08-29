// src/index.ts
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
} from "@earendil-works/pi-coding-agent";
import {
  makeReadOperations,
  makeWriteOperations,
  makeEditOperations,
} from "./operations";
import { createEncodingGrepDefinition } from "./grep";
import { wrapEditToolWithEncodingPreview, clearUtf8Cache } from "./edit-preview";
import { clearConfigCache, shellRuleFor } from "./config";
import { readPiShellSettings } from "./pi-settings";
import { makeTranscodingShellOperations } from "./shell";
import { systemNoteFor } from "./sysnote";
import { clearEncodingNotes, drainEncodingNotes, drainShellNotes, pushEncodingNote, notesToSuffix } from "./notify";
import { clearLegacyHints } from "./legacy-hint";

type AnyText = { type: "text"; text: string };

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
  // encoding-aware preview for GB-encoded files and delegate to the upstream
  // renderer for UTF-8 files (zero UX loss). See src/edit-preview.ts.
  const editDef = createEditToolDefinition(cwd, { operations: makeEditOperations() });
  pi.registerTool(wrapEditToolWithEncodingPreview(editDef, makeEditOperations(), cwd));

  // grep: 有配置的目录树里用自实现（多趟编码 + 逐文件判定）；无配置整体委托内置（§5.1）。
  pi.registerTool(createEncodingGrepDefinition(cwd));

  // P5（§5.5）：shell 输出转码。**默认关闭** —— 只有当前树最近的配置里显式写了
  // transcodeBash 才覆盖 bash/powershell；否则连注册都不做，保证 A-1（无配置零行为变化）。
  // 覆盖时必须把 pi 自己的 shellPath / shellCommandPrefix 带上（我们从 settings.json 镜像），
  // 不然用户设过这两键后装了本扩展就会静默失效 —— 那是行为回归，不是特性。
  const shellRule = shellRuleFor(cwd);
  if (shellRule) {
    const shell = readPiShellSettings(cwd);
    pi.registerTool(
      createBashToolDefinition(cwd, {
        operations: makeTranscodingShellOperations(createLocalBashOperations(), shellRule) as never,
        ...(shell.shellPath ? { shellPath: shell.shellPath } : {}),
        ...(shell.shellCommandPrefix ? { commandPrefix: shell.shellCommandPrefix } : {}),
      }),
    );
    pi.registerTool(
      createPowerShellToolDefinition(cwd, {
        operations: makeTranscodingShellOperations(createLocalPowerShellOperations(), shellRule) as never,
      }),
    );
    for (const w of shellRule.warnings) pushEncodingNote(cwd, w);
  }

  // Caches: config dir cache + classify cache + UTF-8 preview cache + pending notes
  //         + 「无配置静默有损」的一次性提示去重表。
  pi.on("session_start", async () => {
    clearConfigCache();
    clearUtf8Cache();
    clearEncodingNotes();
    clearLegacyHints();
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason === "reload") {
      clearConfigCache();
      clearUtf8Cache();
      clearEncodingNotes();
      clearLegacyHints(); // 用户可能刚照提示跑了 --init → 允许重新探一次
    }
  });

  // §5.2：条件式系统提示。**只有当前 cwd 树里存在 .encoding-converter.json 时才注入**，
  // 无配置目录一个字都不加（A-8）；有配置时内容是常量，prompt cache 前缀仍然稳定。
  let notePromise: Promise<string | null> | null = null;
  const noteOnce = () => {
    if (!notePromise) notePromise = systemNoteFor(cwd);
    return notePromise;
  };
  pi.on("before_agent_start", async (event) => {
    const note = await noteOnce();
    if (!note) return undefined; // 无配置 → 零注入
    return { systemPrompt: event.systemPrompt + "\n\n" + note };
  });

  // 闸门/判定的回显：operations 只寄存提示（见 src/notify.ts 的原因说明），在这里
  // 才贴到工具结果上 —— 磁盘永远看不到这些文字。
  pi.on("tool_result", async (event, ctx) => {
    const name = event.toolName;
    // shell 转码的回显（P5）：不按路径键，单独取
    if (name === "bash" || name === "powershell") {
      const sn = drainShellNotes();
      if (sn.length === 0) return undefined;
      for (const n of sn) ctx.ui?.notify?.(n, "info");
      if (event.isError) return undefined;
      const suffix = notesToSuffix(sn);
      const content = (event.content ?? []) as (AnyText | { type: "image"; data: string; mimeType: string })[];
      return { content: [...content, { type: "text", text: suffix }] };
    }
    if (name !== "read" && name !== "edit" && name !== "write") return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const rel = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
    if (!rel) return undefined;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    const notes = drainEncodingNotes(abs);
    if (notes.length === 0) return undefined;
    for (const n of notes) ctx.ui?.notify?.(n, "info");
    // isError 的结果（闸门拒绝 = 异常文本已含全部信息）不再追加
    if (event.isError) return undefined;
    const suffix = notesToSuffix(notes);
    if (!suffix) return undefined;
    const content = (event.content ?? []) as (AnyText | { type: "image"; data: string; mimeType: string })[];
    return { content: [...content, { type: "text", text: suffix }] };
  });
}
