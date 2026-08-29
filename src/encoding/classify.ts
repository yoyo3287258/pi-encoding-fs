// src/encoding/classify.ts
// §3.1 确定性字节判定器。零外部进程、零启发式打分：只依赖「整文件严格 UTF-8 解码」
// 与「逐字节回环 + 无 U+FFFD」两条可复现的事实（性质 P-1…P-7，见需求文档 §12）。
//
// 与 §3.1 伪代码的对应关系（顺序完全一致）：
//   empty → BOM(utf8/utf16le/utf16be) → NUL=binary → pure-ASCII → 严格 UTF-8
//   → 多字节候选（GB18030/GBK/GB2312/Big5/Shift_JIS/EUC-KR/EUC-JP）
// 三处有意的扩展（都有测试锁定）：
//   1) UTF-32 BOM（FF FE 00 00 / 00 00 FE FF）归入 binary —— Node TextDecoder 不支持
//      UTF-32，误判成 UTF-16 会静默产生 U+FFFD；binary = 不转码 + 拒写，安全侧。
//   2) `force` / kind="config"：配置说了算时跳过字节判定（单字节编码只能这样用，性质 P-6）。
//   3) 大文件（> FULL_SCAN_LIMIT）只做短路扫描：`chosen` 与 §3.1 完全一致，
//      但 `candidates`/`ambiguous` 不保证穷尽 → verdict.exhaustive=false。
import { readFileSync, statSync, promises as fsp } from "node:fs";
import iconv from "iconv-lite";
import {
  AUTO_CJK_CANDIDATES,
  isSingleByteEncoding,
  isStatefulEncoding,
  normalizeEncoding,
} from "./converter";

export type Kind =
  | "utf8"
  | "utf8-bom"
  | "utf16le"
  | "utf16be"
  | "cjk"
  | "binary"
  | "ascii"
  | "unknown"
  | "config"; // 扩展 2

export interface Verdict {
  kind: Kind;
  /** 读侧实际用于解码的编码名（iconv-lite 可用名）；binary/unknown 为 "BINARY"/"UNKNOWN" */
  encoding: string;
  /** 存在第二个也能通过的候选（读结果不唯一） */
  ambiguous: boolean;
  /** 用 `encoding` 解码是否产生 U+FFFD（替换字符 = 已经丢信息） */
  hasFffd: boolean;
  /** 通过判定的候选链（按优先级；未穷尽扫描时可能不完整） */
  candidates: string[];
  /** candidates 是否穷尽扫描过 */
  exhaustive: boolean;
  /** 文件是否带 BOM（写回时要还原，避免 pi splitBom 剥掉后再也回不来） */
  bom: boolean;
  /** 仅 kind==="config" 时有值：force 显式指定 / 该编码在字节层无法判定 */
  configReason?: "force" | "undecidable";
}

export interface ClassifyConfig {
  /** 就近配置（含 overrides 合并后）的读编码 */
  sourceEncoding?: string | null;
  /** 自动候选；只接受 AUTO_CJK_CANDIDATES 里的成员 */
  autoCandidates?: string[];
  /** true = 跳过自动判定，直接按 sourceEncoding 解 */
  force?: boolean;
}

export const DEFAULT_AUTO_CANDIDATES: string[] = [...AUTO_CJK_CANDIDATES];
/** 超过这个大小就不做穷尽候选扫描（实测 1MB 单候选回环 ≈20ms，全 7 候选 ≈140ms）。 */
export const FULL_SCAN_LIMIT = 512 * 1024;
/** NUL 探测窗口（§3.1：containsNul(B, 8192)） */
export const NUL_PROBE_LIMIT = 8192;

const startsWith = (b: Buffer, sig: number[]): boolean => {
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
};

export function containsNul(b: Buffer, limit = NUL_PROBE_LIMIT): boolean {
  const n = Math.min(b.length, limit);
  for (let i = 0; i < n; i++) if (b[i] === 0x00) return true;
  return false;
}

export function isAllAscii(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] > 0x7f) return false;
  return true;
}

/** 整文件严格 UTF-8 判定（不许只看前缀 —— 性质 P-7：截断的多字节序列必须被抓到）。 */
export function isValidUtf8Strict(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** §3.1 的两条候选闸门：逐字节回环相等 + 解码无 U+FFFD。 */
export function exactRoundTrip(b: Buffer, enc: string): boolean {
  try {
    const text = iconv.decode(b, enc);
    if (text.includes("\ufffd")) return false;
    return Buffer.compare(iconv.encode(text, enc), b) === 0;
  } catch {
    return false;
  }
}

function decodeHasFffd(b: Buffer, enc: string): boolean {
  try {
    return iconv.decode(b, enc).includes("\ufffd");
  } catch {
    return true;
  }
}

function normalizeCandidates(list: string[] | undefined): string[] {
  const src = list && list.length ? list : DEFAULT_AUTO_CANDIDATES;
  const out: string[] = [];
  for (const e of src) {
    let n: string;
    try {
      n = normalizeEncoding(e);
    } catch {
      continue; // 不存在的编码名：由 config 层报 warning，这里直接跳过
    }
    if (isSingleByteEncoding(n) || isStatefulEncoding(n)) continue; // 性质 P-6 / §7
    if (!AUTO_CJK_CANDIDATES.includes(n as (typeof AUTO_CJK_CANDIDATES)[number])) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [...DEFAULT_AUTO_CANDIDATES];
}

function configVerdict(b: Buffer, enc: string, reason: "force" | "undecidable"): Verdict {
  return {
    kind: "config",
    encoding: enc,
    ambiguous: false,
    hasFffd: decodeHasFffd(b, enc),
    candidates: [enc],
    exhaustive: true,
    bom: false,
    configReason: reason,
  };
}

/**
 * 判定一个 buffer 的编码。`cfg=null` 表示「没有任何配置」：此时仍给出与配置无关的
 * 判定（utf8/ascii/binary/候选 pass[0]），调用方据此决定是否只读透传。
 */
export function classifyBuffer(B: Buffer, cfg: ClassifyConfig | null = null): Verdict {
  if (B.length === 0) {
    return { kind: "utf8", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };
  }
  // --- BOM 优先（无歧义的强证据，force 也不能推翻） ---
  if (startsWith(B, [0xef, 0xbb, 0xbf]))
    return { kind: "utf8-bom", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };
  // UTF-32 的 BOM 必须以 UTF-16 BOM 之前判掉（扩展 1）
  if (startsWith(B, [0xff, 0xfe, 0x00, 0x00]) || startsWith(B, [0x00, 0x00, 0xfe, 0xff]))
    return { kind: "binary", encoding: "BINARY", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };
  if (startsWith(B, [0xff, 0xfe]))
    return { kind: "utf16le", encoding: "UTF-16LE", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };
  if (startsWith(B, [0xfe, 0xff]))
    return { kind: "utf16be", encoding: "UTF-16BE", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };

  // --- 二进制守卫（任何配置都不能推翻：转码必然毁数据） ---
  if (containsNul(B))
    return { kind: "binary", encoding: "BINARY", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  let pref: string | null = null;
  if (cfg?.sourceEncoding) {
    try {
      pref = normalizeEncoding(cfg.sourceEncoding);
    } catch {
      pref = null; // 非法编码名由 config 层报 warning
    }
  }

  // --- 显式 force：跳过字节判定（§4） ---
  if (cfg?.force && pref) return configVerdict(B, pref, "force");

  // --- 纯 ASCII：读写等价，写由配置决定（§3.2 关键规则） ---
  if (isAllAscii(B))
    return { kind: "ascii", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  // --- UTF-8 优先，且不可被配置推翻（除非显式 force）：性质 P-1 ---
  if (isValidUtf8Strict(B))
    return { kind: "utf8", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  // --- 多字节候选（顺序即优先级；单字节编码永不进入 —— 性质 P-6） ---
  const cands = normalizeCandidates(cfg?.autoCandidates);
  // 配置指定了「字节层无法判定」的编码（单字节 / 转义序列）→ 隐式按配置解（§4 force 的动机）
  if (pref && !cands.includes(pref)) {
    if (isSingleByteEncoding(pref) || isStatefulEncoding(pref)) return configVerdict(B, pref, "undecidable");
  }
  const order = pref && cands.includes(pref) ? [pref, ...cands.filter((c) => c !== pref)] : cands;
  const pass: string[] = [];
  let exhaustive = true;
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    if (!exactRoundTrip(B, e)) continue;
    pass.push(e);
    // 配置命中即短路：真实工程里 3114/3114 个 GBK 文件同时也能被 Big5/EUC-KR 回环，
    // 全量扫描只浪费 CPU，不改变 chosen。
    if (pref && e === pref) {
      exhaustive = false;
      break;
    }
    if (B.length > FULL_SCAN_LIMIT) {
      exhaustive = false;
      break;
    }
  }
  if (pass.length === 0) {
    // 兜底：配置里的候选之外还有非自动候选的编码时，仍值得按配置试一次（响亮失败前最后的可用路径）
    if (pref && !cands.includes(pref))
      return { ...configVerdict(B, pref, "undecidable"), kind: "config" };
    return { kind: "unknown", encoding: "UNKNOWN", ambiguous: false, hasFffd: true, candidates: [], exhaustive: true, bom: false };
  }
  const chosen = pref && pass.includes(pref) ? pref : pass[0];
  return {
    kind: "cjk",
    encoding: chosen,
    ambiguous: exhaustive ? pass.length > 1 : pass.length > 1 || order.length > pass.length,
    hasFffd: false,
    candidates: pass,
    exhaustive,
    bom: false,
  };
}

// ── 文件级缓存（A-7：10 万行级 Java 树首次 read 平均附加延迟 < 5ms；带缓存 < 1ms） ──────

interface CacheEntry {
  mtimeMs: number;
  size: number;
  verdict: Verdict;
}
const fileCache = new Map<string, CacheEntry>();
const fsStat = fsp.stat;
const CFG_SEP = "\u0000";

function cfgKeyPart(cfg: ClassifyConfig | null): string {
  if (!cfg) return "-";
  return `${cfg.sourceEncoding ?? "-"}|${(cfg.autoCandidates ?? []).join(",")}|${cfg.force ? 1 : 0}`;
}

/** 带 mtime+size 失效的文件判定（同步版，给 renderCall 这种同步入口用）。 */
export function classifyFileCached(absPath: string, cfg: ClassifyConfig | null): Verdict {
  const key = cacheKey(absPath, cfg);
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return classifyBuffer(Buffer.alloc(0), cfg); // 新文件：等价于空 buffer 判定
  }
  const hit = fileCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.verdict;
  const verdict = classifyBuffer(readFileSync(absPath), cfg);
  store(key, st, verdict);
  return verdict;
}

/**
 * 异步版：调用方已经把整个文件读成 buffer（pi 的 read 就是这样），所以这里只「省 CPU」：
 * 命中缓存则跳过解码/回环，未命中则用传入的 buffer 计算并记录 stat。
 */
export async function verdictForBuffer(absPath: string, buf: Buffer, cfg: ClassifyConfig | null): Promise<Verdict> {
  const key = cacheKey(absPath, cfg);
  let st;
  try {
    st = await fsStat(absPath);
  } catch {
    return classifyBuffer(buf, cfg);
  }
  const hit = fileCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.verdict;
  const verdict = classifyBuffer(buf, cfg);
  store(key, st, verdict);
  return verdict;
}

function cacheKey(absPath: string, cfg: ClassifyConfig | null): string {
  return absPath + CFG_SEP + cfgKeyPart(cfg);
}

function store(key: string, st: { mtimeMs: number; size: number }, verdict: Verdict): void {
  fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, verdict });
  if (fileCache.size > 20000) {
    // 简单上限：丢掉最早的一半，避免在超大仓库里无界增长。
    for (const k of [...fileCache.keys()].slice(0, 10000)) fileCache.delete(k);
  }
}

export function clearClassifyCache(): void {
  fileCache.clear();
}

/** 写完后自校验/配置热更新时用：只失效这个路径。 */
export function invalidateClassifyCache(absPath: string): void {
  for (const k of [...fileCache.keys()]) if (k.split(CFG_SEP)[0] === absPath) fileCache.delete(k);
}

/** 判定结果的人类可读标签（读结果里的警告行、grep 输出、测试快照共用）。 */
export function describeVerdict(v: Verdict): string {
  const bits = [`${v.kind}:${v.encoding}`];
  if (v.ambiguous) bits.push(`候选=${v.candidates.join(">") || "多"}`);
  if (v.hasFffd) bits.push("含U+FFFD");
  return bits.join(" ");
}
