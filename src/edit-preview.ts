// src/edit-preview.ts
//
// Pi's `edit` tool has two file-reading code paths:
//   1. `execute()`        -> uses the injected `operations.readFile` (encoding-aware) ✅
//   2. `renderCall()`      -> calls `computeEditsDiff()`, which uses the BUILT-IN
//      Node `readFile(path, "utf-8")` and never goes through `operations.readFile` ❌
//
// For a GB18030/GBK file the preview therefore reads raw GB bytes as UTF-8
// (mojibake), cannot find the (correct UTF-8) `oldText`, and shows a false red
// "Could not find the exact text in <path>" box during streaming — even though
// the real edit (execute) succeeds.
//
// We cannot fix this upstream (computeEditsDiff is hardcoded to fs.readFile and
// is not exported from the package, nor is applyEditsToNormalizedContent), and
// `EditToolOptions` exposes no preview-readFile injection point. So we override
// the ToolDefinition's plain `renderCall` field (which tool-execution honors:
// `toolDefinition.renderCall ?? builtIn.renderCall`) to run our OWN encoding-
// aware preview for GB-encoded files, and delegate to the upstream renderer for
// UTF-8 files (zero UX loss there).
//
// This module is self-contained: every primitive it needs is part of the
// PUBLIC API of @earendil-works/pi-coding-agent / @earendil-works/pi-tui:
//   - generateDiffString            (public index, edit-diff)
//   - renderDiff                    (public index, interactive components)
//   - Theme, ThemeColor, ThemeBg    (public index, theme)
//   - Box / Text / Spacer / Container (@earendil-works/pi-tui)
// The tiny BOM-strip + LF-normalize + line-ending-detect helpers are re-implemented
// here verbatim from Pi's edit-diff (they are 4-line pure functions, NOT exported),
// so we never deep-import a private module.

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { configGeneration, findNearestConfigSync, resolveFileRule } from "./config";
import { classifyBuffer } from "./encoding/classify";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text, Spacer } from "@earendil-works/pi-tui";
import {
  generateDiffString,
  renderDiff,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// --- Minimal diff primitives (verbatim from Pi's edit-diff, not exported publicly) ---

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

interface EditEdit {
  oldText: string;
  newText: string;
}

/**
 * Apply edits to LF-normalized content using EXACT matching only.
 *
 * We deliberately do not replicate Pi's fuzzy matching (normalizeForFuzzyMatch +
 * fuzzyFindText): those are private. In the preview path the file content has
 * already been decoded to clean UTF-8 by `ops.readFile`, and `oldText` arrives
 * as clean UTF-8 from the model, so exact `indexOf` matches what execute() will
 * do for ASCII/ASCII-compatible regions. Fuzzy matching exists upstream mainly
 * to absorb trailing-whitespace / smart-quote drift; if exact match fails here
 * we simply render no diff body (header only), and the real execute() — which
 * DOES fuzzy-match — still runs. Worst case: GB files lose the streaming diff
 * body for edits that needed fuzzy matching, but never get a false red error.
 *
 * Mirrors Pi's contract: edits matched against the ORIGINAL content (not
 * incrementally), applied in reverse order so offsets stay stable; throws on
 * empty oldText / not-found / duplicate / overlap.
 */
function applyEditsExact(normalizedContent: string, edits: EditEdit[], filePath: string): { baseContent: string; newContent: string } {
  const lfEdits = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
  for (let i = 0; i < lfEdits.length; i++) {
    if (lfEdits[i].oldText.length === 0) {
      throw new Error(`edits[${i}].oldText must not be empty in ${filePath}.`);
    }
  }
  // Match against the same original (LF-normalized) content; reverse-order apply.
  type Matched = { matchIndex: number; matchLength: number; newText: string };
  const matched: Matched[] = [];
  for (let i = 0; i < lfEdits.length; i++) {
    const idx = normalizedContent.indexOf(lfEdits[i].oldText);
    if (idx === -1) {
      // Exact-match miss in the preview: surface the same wording execute() would,
      // but rendered as the header bg, not as a red error box (we KNOW execute
      // may still fuzzy-match and succeed).
      throw new Error(
        `Preview: could not exactly locate edits[${i}] in ${filePath}. The edit will still be attempted on execution.`,
      );
    }
    const occurrences = normalizedContent.split(lfEdits[i].oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(`Preview: edits[${i}] is not unique in ${filePath} (${occurrences} occurrences); execution will also reject this.`);
    }
    matched.push({ matchIndex: idx, matchLength: lfEdits[i].oldText.length, newText: lfEdits[i].newText });
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    if (matched[i - 1].matchIndex + matched[i - 1].matchLength > matched[i].matchIndex) {
      throw new Error(`edits[${i - 1}] and edits[${i}] overlap in ${filePath}.`);
    }
  }
  let newContent = normalizedContent;
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    newContent = newContent.substring(0, m.matchIndex) + m.newText + newContent.substring(m.matchIndex + m.matchLength);
  }
  return { baseContent: normalizedContent, newContent };
}

// --- mtime-cached 同步预览路由判定（§5.3）------------------------------------------------
// renderCall() 是同步的，只能用同步链路。以前这里是一段
// `new TextDecoder("utf-8", { fatal: true })` 的二分判定 —— 它只能区分“是不是合法 UTF-8”，
// 于是 ISO-8859-1 / windows-1252 这类“字节层不可判定、只能靠配置”的文件会被当成
// 普通非 UTF-8 误路由（P3 要求：这里必须复用 classifyBuffer）。
// 现在：读字节 → 取就近配置（同步版，共用 dirCache）→ classifyBuffer → 问“我们的解码链
// 与上游预览（utf-8 直读）会不会不一样”，不一样才走我们的预览渲染。

interface CacheEntry {
  mtimeMs: number;
  size: number;
  gen: number;
  upstreamPreviewIsSafe: boolean;
}
const utf8Cache = new Map<string, CacheEntry>();

/** true = 上游 utf-8 直读的预览与真实内容一致，交给内置渲染器（零 UX 损失） */
export function isUtf8FileCached(absPath: string): boolean {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(absPath);
  } catch {
    // 无法 stat（新文件/路径不存在）→ 宽松处理：交给上游，它对“文件缺失”的提示更统一
    return true;
  }
  const gen = configGeneration();
  const cached = utf8Cache.get(absPath);
  // 键用 mtime + size：Windows 的 mtime 只到毫秒粒度，同一毫秒内的两次写入会拿到完全
  // 相同的 mtime，只比 mtime 就会读到过期结论（CI 的 windows runner 上实跟过）。
  // 加 size 后同毫秒改写只要长度变了就能失效；连长度都没变的极端情况只会错一个
  // 预览渲染分支（不影响任何字节），configGeneration / 重启会收拾。
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.gen === gen)
    return cached.upstreamPreviewIsSafe;
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return true;
  }
  const found = findNearestConfigSync(path.dirname(absPath));
  if (!found) {
    // 无配置 → 完全透传，与未装扩展一致（A-1）：上游预览天然是对的
    utf8Cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, gen, upstreamPreviewIsSafe: true });
    return true;
  }
  const rule = resolveFileRule(absPath, found);
  const v = classifyBuffer(buf, {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  });
  // utf8 / utf8-bom / ascii → 与 utf-8 直读等价；binary / unknown → 我们的解码也帮不上；
  // cjk / config(非 UTF-8) / utf16 → 必须走我们的预览（否则 GB 文件会渲染乱码 diff）
  const safe =
    v.kind === "utf8" || v.kind === "utf8-bom" || v.kind === "ascii" || v.kind === "binary" || v.kind === "unknown";
  utf8Cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, gen, upstreamPreviewIsSafe: safe });
  if (utf8Cache.size > 512) {
    const firstKey = utf8Cache.keys().next().value;
    if (firstKey) utf8Cache.delete(firstKey);
  }
  return safe;
}

/** 旧名字保留（语义已换）：现在等价于 !isUtf8FileCached(path) */
export function needsEncodingPreview(absPath: string): boolean {
  return !isUtf8FileCached(absPath);
}

export function clearUtf8Cache(): void {
  utf8Cache.clear();
}

// --- Header rendering (mirrors Pi's edit tool header so GB files look native) ----------------

interface EditPreviewArgs {
  path?: string;
  file_path?: string;
  edits?: EditEdit[];
  oldText?: string;
  newText?: string;
}

function getEditPath(args: EditPreviewArgs): string | null {
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return null;
}

function getEditList(args: EditPreviewArgs): EditEdit[] | null {
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")
  ) {
    return args.edits;
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return null;
}

/**
 * Format the `edit <path>` header the same way Pi does, so GB files are
 * visually consistent with UTF-8 edits in the tool-call row.
 */
function formatEditHeader(args: EditPreviewArgs, theme: Theme, cwd: string): string {
  const rawPath = getEditPath(args);
  const display = rawPath ? path.relative(cwd, path.resolve(cwd, rawPath)) || rawPath : "(no path)";
  return `${theme.fg("toolTitle", theme.bold("edit"))} ${display}`;
}

// --- The exported wrapper -------------------------------------------------------------------

// `ToolRenderContext` is not exported from the public index, so we declare the
// minimal structural slice of it we read inside the overridden renderCall.
interface EditRenderContext {
  lastComponent: Component | undefined;
  state: { callComponent?: Box } & Record<string, unknown>;
  invalidate: () => void;
  argsComplete: boolean;
}

/**
 * Override `renderCall` on an edit ToolDefinition so GB18030/GBK files get an
 * encoding-aware preview (computed from `readFile`-decoded UTF-8) instead of
 * Pi's `computeEditsDiff` preview (which reads raw bytes as UTF-8 and shows a
 * false "Could not find the exact text" error on Chinese).
 *
 * - ISO-8859 / Windows-1252 (single-byte 0x80-0xFF) would be wrongly flagged
 *   as "not UTF-8" here even though they rarely occur in a codebase that has a
 *   `.encoding-converter.json`. If that ever matters, gate this override on the
 *   config's `sourceEncoding` being a GB encoding instead of the byte probe.
 */
export function wrapEditToolWithEncodingPreview(
  def: ToolDefinition<any, any, any>,
  operations: {
    readFile: (absPath: string) => Promise<Buffer>;
  },
  cwd: string,
): ToolDefinition<any, any, any> {
  const upstreamRenderCall = def.renderCall;
  if (typeof upstreamRenderCall !== "function") return def;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def.renderCall = (args: any, theme: Theme, context: any): Component => {
    const rawPath = getEditPath(args as EditPreviewArgs);
    // No path, or file is genuinely UTF-8 -> upstream preview is correct.
    if (!rawPath || isUtf8FileCached(path.resolve(cwd, rawPath))) {
      return upstreamRenderCall(args, theme, context);
    }

    const ctx = context as EditRenderContext;
    // GB-encoded file: render our own header now, and compute the diff async,
    // patching the component in place when it resolves (mirrors Pi's pattern).
    const component =
      ctx.lastComponent instanceof Box ? (ctx.lastComponent as Box) : ctx.state.callComponent ?? new Box(1, 1, (t) => theme.bg("toolPendingBg", t));
    ctx.state.callComponent = component;

    const argsKey = JSON.stringify({ path: rawPath, edits: getEditList(args as EditPreviewArgs) });
    const st = component as Box & {
      preview?: { diff?: string; error?: string } | undefined;
      previewArgsKey?: string | undefined;
      previewPending?: boolean;
      settledError?: boolean;
    };
    if (st.previewArgsKey !== argsKey) {
      st.preview = undefined;
      st.previewArgsKey = argsKey;
      st.previewPending = false;
      st.settledError = false;
    }

    const build = (bgFn: (t: string) => string) => {
      component.setBgFn(bgFn);
      component.clear();
      component.addChild(new Text(formatEditHeader(args as EditPreviewArgs, theme, cwd), 0, 0));
      let body: string | undefined;
      if (st.preview) {
        if ("error" in st.preview && st.preview.error) {
          body = theme.fg("error", st.preview.error);
        } else if (st.preview.diff) {
          // renderDiff reads Pi's theme singleton internally; guard so a render
          // failure on a not-yet-initialized theme (e.g. very early in a test/
          // custom host) cannot crash the whole tool-call row. Falling back to
          // the raw diff string still shows something useful.
          try {
            body = renderDiff(st.preview.diff, { filePath: rawPath });
          } catch {
            body = st.preview.diff;
          }
        }
      }
      if (body) {
        component.addChild(new Spacer(1));
        component.addChild(new Text(body, 0, 0));
      }
      return component;
    };

    // Pending state: render header immediately.
    build((t) => theme.bg("toolPendingBg", t));

    if (ctx.argsComplete && getEditList(args as EditPreviewArgs) && !st.preview && !st.previewPending) {
      st.previewPending = true;
      const requestKey = argsKey;
      const absolutePath = path.resolve(cwd, rawPath);
      void (async () => {
        let preview: { diff?: string; error?: string };
        try {
          const buffer = await operations.readFile(absolutePath);
          const rawContent = buffer.toString("utf-8");
          const { text: withoutBom } = stripBom(rawContent);
          const ending = detectLineEnding(withoutBom);
          const normalized = normalizeToLF(withoutBom);
          const { baseContent, newContent } = applyEditsExact(normalized, getEditList(args as EditPreviewArgs)!, rawPath);
          const finalNew = restoreLineEndings(newContent, ending);
          const { diff } = generateDiffString(baseContent, finalNew, 4);
          preview = { diff };
        } catch (err) {
          preview = { error: err instanceof Error ? err.message : String(err) };
        }
        if (st.previewArgsKey === requestKey) {
          st.preview = preview;
          st.previewPending = false;
          st.settledError = Boolean(preview.error);
          try {
            build(
              preview.error
                ? (t) => theme.bg("toolErrorBg", t)
                : (t) => theme.bg("toolSuccessBg", t),
            );
          } catch {
            // If theming/rendering throats (e.g. theme singleton not yet
            // initialized in a non-TUI host), leave the already-rendered header
            // in place rather than crashing the row. The diff string itself is
            // already stored on st.preview.diff for renderResult to use.
          }
          ctx.invalidate();
        }
      })();
    }

    return component;
  };

  return def;
}
