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
import { clearConfigCache } from "./config";
import { resolveReadPlan, resolveWritePlan, type WritePlan } from "./resolve";
import { decodeToUtf8, encodeFromUtf8 } from "./encoding/converter";
import { invalidateClassifyCache } from "./encoding/classify";
import { detectLineEnding, restoreLineEndings, type LineEndingStyle } from "./encoding/line-endings";
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
  if (!plan) return raw; // 无配置 → 逐字节透传（§8 A-1）
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

/** 闸门 1（不可映射字符）与闸门 2（回读自校验）在 P2 接入；P1 先落决策矩阵与 BOM 规则。 */
async function encodeForWrite(plan: WritePlan, content: string, absPath: string): Promise<Buffer> {
  const enc = plan.encoding!;
  // pi 的 edit 会把 `bom + content` 原样传进来；BOM 统一由 plan.addBom 在字节层还原，
  // 所以这里先把 U+FEFF 从文本里摘掉，避免双份 BOM。
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const upper = enc.toUpperCase();
  if (upper === "UTF-8") {
    // 行尾交给 pi 自己处理（它的 edit-diff 已经恢复过一次），我们只负责补回 BOM。
    const bom = plan.addBom === "utf8" ? BOM_BYTES.utf8 : Buffer.alloc(0);
    return Buffer.concat([bom, Buffer.from(body, "utf-8")]);
  }
  const style = await detectExistingLineEnding(absPath);
  const restored = style ? restoreLineEndings(body, style) : body;
  const bytes = encodeFromUtf8(restored, enc);
  const bom =
    plan.addBom === "utf16le" ? BOM_BYTES.utf16le : plan.addBom === "utf16be" ? BOM_BYTES.utf16be : Buffer.alloc(0);
  return Buffer.concat([bom, bytes]);
}

async function writeEncoded(absPath: string, utf8content: string): Promise<void> {
  const plan = await resolveWritePlan(absPath, utf8content);
  if (plan.reject) throw new Error(plan.reject); // 闸门 3：拿不准就不写

  if (!plan.encoding) {
    // 完全透传：与未装本扩展逐字节一致
    await writeFile(absPath, utf8content, "utf-8");
  } else {
    const bytes = await encodeForWrite(plan, utf8content, absPath);
    await writeFile(absPath, bytes);
  }
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

export function makeWriteOperations(): WriteOperations {
  return {
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  };
}

export function makeEditOperations(): EditOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    access: (absPath) => access(absPath, constants.R_OK | constants.W_OK),
  };
}

// P2 会用到：同目录临时文件 + fsync + rename 的原子替换（以及写前备份回滚）。
export async function atomicReplace(absPath: string, bytes: Buffer): Promise<void> {
  const tmp = `${absPath}.${randomBytes(6).toString("hex")}.encfs.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, absPath);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
