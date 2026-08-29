// src/operations.ts — 字节 IO 注入点（pi 的 read/write/edit 通过这里的 operations 对象走我们）。
// 决策全在 resolve.ts，判定全在 encoding/classify.ts；本文件负责：
//   读：图片保护 → 计划 → 解码 →（必要时）追加一行警告
//   写：计划 → 闸门（P2）→ 行尾保真 → BOM 还原 → 原子替换
import { readFile, writeFile, mkdir, access, rename, unlink, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
} from "@earendil-works/pi-coding-agent";
import { clearConfigCache, type ResolvedConfig } from "./config";
import { resolveReadPlan, resolveWritePlan, type WritePlan } from "./resolve";
import {
  canEncodeAll,
  charListMessage,
  decodeToUtf8,
  encodeFromUtf8,
  escapeUnmappable,
  isGBEncoding,
  normalizeEncoding,
  unmappableChars,
} from "./encoding/converter";
import { classifyBuffer, describeVerdict, invalidateClassifyCache } from "./encoding/classify";
import { detectLineEnding, restoreLineEndings, type LineEndingStyle } from "./encoding/line-endings";
import { pushEncodingNote } from "./notify";
import { hintOnNoConfigRead, hintOnNoConfigWrite } from "./legacy-hint";
import {
  detectSupportedImageMimeType,
  detectSupportedImageMimeTypeFromFile,
} from "./encoding/mime";

const BOM_BYTES = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
  utf16be: Buffer.from([0xfe, 0xff]),
} as const;

async function readAsUtf8Buffer(absPath: string): Promise<Buffer> {
  const raw = await readFile(absPath);
  // 图片必须保持二进制：pi 的 read 在 MIME 命中后仍会调用 ops.readFile()，
  // 对 PNG/JPEG 字节跑转码会同时毁掉图片并让模型收不到附件。
  if (detectSupportedImageMimeType(raw)) return raw;

  const plan = await resolveReadPlan(absPath);
  if (!plan) {
    // 无配置 → 逐字节透传（§8 A-1）。但 pi 内置 read 是**有损不报错**的，
    // 所以这里只寄存一条提示（不改字节、不改返回值）—— 方案乙。
    await hintOnNoConfigRead(absPath, raw);
    return raw;
  }
  // 非致命提示不进文件内容（会被 edit 当基线写回），只寄存给 P3 的 tool_result 回显
  for (const w of plan.warnings) pushEncodingNote(absPath, w);
  if (plan.verdict.kind === "binary") return raw; // 不转码；pi 自己的二进制分支处理
  if (plan.encoding === "UTF-8" || plan.encoding === "BINARY" || plan.encoding === "UNKNOWN") {
    // 原样返回字节（含 BOM —— pi 的 splitBom 会自行处理，我们先剥会导致写回时 BOM 丢失）
    return plan.note ? Buffer.concat([raw, Buffer.from(`\n\n${plan.note}\n`, "utf-8")]) : raw;
  }
  const text = decodeToUtf8(raw, plan.encoding);
  const out = Buffer.from(text, "utf-8");
  return plan.note ? Buffer.concat([out, Buffer.from(`\n\n${plan.note}\n`, "utf-8")]) : out;
}

async function detectExistingLineEnding(absPath: string): Promise<LineEndingStyle | null> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return null;
    const raw = await readFile(absPath);
    return detectLineEnding(raw);
  } catch {
    return null;
  }
}

/**
 * 闸门 1（§3.3）：不可映射字符必须响亮失败，禁止静默变成 `?`。
 * 策略："error"（默认）| "escape"（转 \uXXXX）| "drop-to-gb18030"（自动升级到 GB18030）。
 */
function gate1Message(absPath: string, bad: string[], enc: string, strategy: string): string {
  const list = charListMessage(bad.slice(0, 12));
  const more = bad.length > 12 ? `…共 ${bad.length} 个不同字符` : "";
  return (
    `闸门 1 拒写 ${absPath}：目标编码 ${enc} 无法表示以下内容（写下去会永久变成 '?'）：` +
    `${list}${more}。` +
    (isGBEncoding(enc)
      ? `建议把该目录/该 pattern 的 "writeEncoding" 改成 "GB18030"（它是 GBK 的严格超集，` +
        `对既有 GBK 内容逐字节不变，性质 P-4）。`
      : `建议把 "writeEncoding" 改成能包含这些码点的编码（如 UTF-8 / GB18030）。`) +
    `（当前 unmappable="${strategy}"；也可用 "escape" 转 \\uXXXX，或 "drop-to-gb18030" 自动升级）`
  );
}

function applyGate1(
  plan: WritePlan,
  text: string,
  absPath: string,
): { encoding: string; text: string; note: string | null } {
  const enc = plan.encoding!;
  const strategy = plan.rule?.unmappable ?? "error";
  if (canEncodeAll(text, enc)) return { encoding: enc, text, note: null };
  const bad = unmappableChars(text, enc);
  if (bad.length === 0) return { encoding: enc, text, note: null }; // canEncodeAll 的保守判否，逐码点确认无损
  if (strategy === "escape") {
    const escaped = escapeUnmappable(text, enc);
    return {
      encoding: enc,
      text: escaped,
      note:
        `闸门 1（escape）：${bad.length} 个 ${enc} 无法表示的字符已转成 \\uXXXX 转义：` +
        `${charListMessage(bad.slice(0, 12))}`,
    };
  }
  if (strategy === "drop-to-gb18030" && isGBEncoding(enc) && normalizeEncoding(enc) !== "GB18030") {
    if (unmappableChars(text, "GB18030").length === 0) {
      return {
        encoding: "GB18030",
        text,
        note:
          `闸门 1（drop-to-gb18030）：${enc} 无法表示 ${charListMessage(bad.slice(0, 12))}，` +
          `本次已自动改用 GB18030 写出（对既有 GBK 内容逐字节不变）`,
      };
    }
    throw new Error(gate1Message(absPath, unmappableChars(text, "GB18030"), "GB18030", strategy));
  }
  throw new Error(gate1Message(absPath, bad, enc, strategy));
}

async function encodeForWrite(
  plan: WritePlan,
  encoding: string,
  text: string,
  absPath: string,
): Promise<{ bytes: Buffer; text: string; bomLen: number }> {
  // pi 的 edit 会把 `bom + content` 原样传进来；BOM 统一由 plan.addBom 在字节层还原，
  // 所以这里先把 U+FEFF 从文本里摘掉，避免双份 BOM。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const upper = encoding.toUpperCase();
  if (upper === "UTF-8") {
    // 行尾交给 pi 自己处理（它的 edit-diff 已经恢复过一次），我们只负责补回 BOM。
    const bom = plan.addBom === "utf8" ? BOM_BYTES.utf8 : Buffer.alloc(0);
    return { bytes: Buffer.concat([bom, Buffer.from(body, "utf-8")]), text: body, bomLen: bom.length };
  }
  const style = await detectExistingLineEnding(absPath);
  const restored = style ? restoreLineEndings(body, style) : body;
  const bytes = encodeFromUtf8(restored, encoding);
  const bom =
    plan.addBom === "utf16le" ? BOM_BYTES.utf16le : plan.addBom === "utf16be" ? BOM_BYTES.utf16be : Buffer.alloc(0);
  return { bytes: Buffer.concat([bom, bytes]), text: restored, bomLen: bom.length };
}

/**
 * 闸门 2：写后回读自校验。三件事：字节与我们要写的完全一致 → 判定仍是那个编码 →
 * 解码回来与期望文本相等。失败返回错因，调用方负责回滚。
 */
async function verifyWritten(
  absPath: string,
  expectedBytes: Buffer,
  expectedText: string,
  encoding: string,
  rule: ResolvedConfig,
  bomLen = 0,
): Promise<string | null> {
  let written: Buffer;
  try {
    written = await readFile(absPath);
  } catch (e) {
    return `写后无法回读（${(e as Error).message}）`;
  }
  if (Buffer.compare(written, expectedBytes) !== 0) {
    return `写后回读的字节与预期不一致（${written.length}B vs ${expectedBytes.length}B，可能被其它进程改写）`;
  }
  const v = classifyBuffer(written, {
    sourceEncoding: encoding,
    autoCandidates: rule.autoCandidates,
    force: false,
  });
  const encU = encoding.toUpperCase();
  const okKind =
    v.kind === "ascii" || // 内容恰好全是 ASCII：字节上无法区分，不算错
    (encU === "UTF-8" && (v.kind === "utf8" || v.kind === "utf8-bom")) ||
    (encU !== "UTF-8" && (v.kind === "cjk" || v.kind === "config")) ||
    (encU === "UTF-16LE" && v.kind === "utf16le") ||
    (encU === "UTF-16BE" && v.kind === "utf16be");
  if (!okKind) return `写后判定为 ${describeVerdict(v)}，与期望 ${encoding} 不符`;
  if (encU !== "UTF-8" && v.kind === "cjk" && normalizeEncoding(v.encoding) !== normalizeEncoding(encoding)) {
    return `写后判定为 ${v.encoding}，与期望 ${encoding} 不符`;
  }
  const text =
    encU === "UTF-8"
      ? written.subarray(bomLen).toString("utf-8")
      : decodeToUtf8(written.subarray(bomLen), encoding);
  if (text !== expectedText) {
    const i = firstDiffIndex(text, expectedText);
    return `写后按 ${encoding} 解码与期望文本不一致（首个差异偏移 ${i}）`;
  }
  return null;
}

function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export interface WriteSeam {
  /** 落盘方式（默认为同目录临时文件 + fsync + rename 的原子替换）；测试可注入以验证回滚 */
  writeBytes: (absPath: string, bytes: Buffer) => Promise<void>;
}

export const defaultWriteSeam: WriteSeam = { writeBytes: atomicReplace };

async function writeEncoded(absPath: string, utf8content: string, seam: WriteSeam = defaultWriteSeam): Promise<void> {
  // 同一个文件的写必须串行（备份 → 落盘 → 回读校验 → 必要时回滚是一个整体事务）
  await withPathLock(absPath, () => writeEncodedLocked(absPath, utf8content, seam));
}

async function writeEncodedLocked(
  absPath: string,
  utf8content: string,
  seam: WriteSeam,
): Promise<void> {
  const plan = await resolveWritePlan(absPath, utf8content);
  if (plan.reject) throw new Error(plan.reject); // 闸门 3：拿不准就不写
  for (const w of plan.warnings) pushEncodingNote(absPath, w);

  if (!plan.encoding) {
    // 完全透传：用与 pi 内置一致的 writeFile（不提前新建 inode、不改换文件）→
    // 保证 §8 A-1「无配置目录行为与未装扩展逐字节一致」。原子替换只用于我们真的转码时。
    // plan.rule === null 即“本目录真的没有配置”（有配置但不需转码时 rule 非空）。
    if (plan.rule === null) await hintOnNoConfigWrite(absPath); // 只说话，不拦（方案乙）
    await writeFile(absPath, utf8content, "utf-8");
    afterWrite(absPath);
    return;
  }

  // 闸门 1：不可映射字符（可能升级编码或改写文本，因此必须在编码之前做）
  const g1 = applyGate1(plan, utf8content, absPath);
  if (g1.note) pushEncodingNote(absPath, g1.note);
  const { bytes, text, bomLen } = await encodeForWrite(plan, g1.encoding, g1.text, absPath);

  // 闸门 2：写前备份 + 原子替换 + 写后回读自校验，不一致就回滚
  const verify = plan.rule?.verifyWrite !== false;
  let backup: Buffer | null = null;
  try {
    backup = await readFile(absPath);
  } catch {
    backup = null; // 新建文件
  }
  try {
    await seam.writeBytes(absPath, bytes);
  } catch (e) {
    if (backup) await seam.writeBytes(absPath, backup).catch(() => undefined);
    throw new Error(
      `写入 ${absPath} 失败，磁盘保持原样：${(e as Error).message}${g1.note ? `（${g1.note}）` : ""}`,
    );
  }
  if (verify && plan.rule) {
    const problem = await verifyWritten(absPath, bytes, text, g1.encoding, plan.rule, bomLen);
    if (problem) {
      if (backup) {
        await seam.writeBytes(absPath, backup).catch(() => undefined);
        throw new Error(
          `闸门 2（写后自校验）失败：${problem}。已回滚为写前内容。${g1.note ? `（${g1.note}）` : ""}`,
        );
      }
      await unlink(absPath).catch(() => undefined);
      throw new Error(
        `闸门 2（写后自校验）失败：${problem}。该文件写前不存在，已删除半成品。${g1.note ? `（${g1.note}）` : ""}`,
      );
    }
  }
  afterWrite(absPath);
}

function afterWrite(absPath: string): void {
  invalidateClassifyCache(absPath);
  // 写配置会改变其下整棵树的编码决策 → 失效缓存
  if (path.basename(absPath) === ".encoding-converter.json") {
    clearConfigCache();
  }
}

export function makeReadOperations(): ReadOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    access: (absPath) => access(absPath, constants.R_OK),
    // 必需：没有这个 hook，pi 会跳过图片分支、把 PNG/JPEG 当 UTF-8 文本读（模型拿不到附件）。
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
  };
}

export function makeWriteOperations(seam: WriteSeam = defaultWriteSeam): WriteOperations {
  return {
    writeFile: (absPath, content) => writeEncoded(absPath, content, seam),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  };
}

export function makeEditOperations(seam: WriteSeam = defaultWriteSeam): EditOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    writeFile: (absPath, content) => writeEncoded(absPath, content, seam),
    access: (absPath) => access(absPath, constants.R_OK | constants.W_OK),
  };
}

// 同目录临时文件 + fsync + rename 的原子替换（闸门 2 的基础），带 Windows 重试。
/** rename 在 Windows 上会因瞬时占用（索引起/杀软/另一个句柄正在读）报 EPERM/EACCES/EBUSY */
const RENAME_RETRY_MS = [0, 8, 16, 32, 64, 128];

function isTransientLockError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY" || code === "EDELET";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 同目录临时文件 + fsync + rename 的原子替换（闸门 2 的基础），带 Windows 重试 */
export async function atomicReplace(absPath: string, bytes: Buffer): Promise<void> {
  const tmp = `${absPath}.${randomBytes(6).toString("hex")}.encfs.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, absPath);
      return;
    } catch (e) {
      // rename 失败时 tmp 仍在原地 → 清理后按退避重试；重试用尽才向上报错
      await unlink(tmp).catch(() => undefined);
      if (i >= RENAME_RETRY_MS.length - 1 || !isTransientLockError(e)) throw e;
      await sleep(RENAME_RETRY_MS[i]);
      // 重试要重新生成临时文件（上一份已删）
      const again = await open(tmp, "w");
      try {
        await again.writeFile(bytes);
        await again.sync();
      } finally {
        await again.close();
      }
    }
  }
}

// 同一文件的写必须串行：否则 A 的“写后回读自校验”会读到 B 刚写的内容，
// 把好的结果误判成不一致并回滚掉 B 的写入（丢失更新）。
// 这也是上面 EPERM 的根因：同进程内并发 rename 到同一个目标在 Windows 上必打架。
const pathLocks = new Map<string, Promise<void>>();

/** 按绝对路径串行化一段异步操作（大小写不敏感，Windows/macOS 需要） */
export async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const k = path.resolve(absPath).toLowerCase();
  const tail = pathLocks.get(k) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  pathLocks.set(k, guard);
  try {
    return await run;
  } finally {
    if (pathLocks.get(k) === guard) pathLocks.delete(k);
  }
}
