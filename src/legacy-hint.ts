/**
 * 方案乙：无配置目录里的「静默有损」必须被说出来（但不改任何字节）。
 *
 * 事实依据（实测，pi 0.84.3）：`dist/core/tools/read.js:196` 用 `buffer.toString("utf-8")`
 * 解码 —— Node 这个方法是**有损**的，永不抛错。所以本扩展遵守 §8 A-1（无配置 = 与未装扩展
 * 逐字节一致）而透传时，模型拿到的是 `????????`/U+FFFD 而不是错误，实测模型会拿着乱码自己
 * “补”出通顺中文并声称是原样引用。
 *
 * 这里的取舍：
 *   - **不改字节、不改返回值**（A-1 仍然成立，内容仍由 pi 内置产出）；
 *   - 只在真的确定有问题时寄存一条提示，走 P3 的 `tool_result` 通道给模型 + UI；
 *   - 判不准就不说（宁缺毋滥）：只有"字节确定不是 UTF-8、且能被候选编码解出含非 ASCII 文本"
 *     或"根本解不出来"才提示；UTF-8 / ASCII / 二进制一律安静。
 */
import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import { classifyBuffer } from "./encoding/classify";
import type { Kind } from "./encoding/classify";
import { pushEncodingNote } from "./notify";

/** 大到这个尺寸就不探了（分类本身是线性的；这种文件 pi 也不会整份给模型看） */
const PROBE_MAX_BYTES = 8 * 1024 * 1024;
/** 去重表上限，防止长会话无限增长 */
const CACHE_MAX = 4000;

/** path -> `${mtimeMs}:${size}:${purpose}`；同一份内容的同一个场景只提示一次 */
const told = new Map<string, string>();

/** 哪些判定结果属于「pi 原样读会静默变坏」 */
const HINTABLE: Kind[] = ["cjk", "unknown", "utf16le", "utf16be", "config"];

export function legacyReadHintMessage(kind: Kind, encoding: string, ambiguous: boolean, candidates: string[] = []): string | null {
  const init = `node <扩展目录>/tools/scan-encoding.mjs . --init`;
  switch (kind) {
    case "cjk":
      return (
        `本目录没有 .encoding-converter.json，而该文件按字节是 ${encoding}` +
        `${ambiguous ? "（歧义候选：" + (candidates.length ? candidates.slice(0, 6).join("/") : encoding) + "，字节本身分不出具体哪种）" : ""}。` +
        `pi 内置 read 会把它当 UTF-8 有损解码成问号/替换字符，**不会报错** —— ` +
        `你看到的乱码不是文件内容，请勿照原样改写回去（那会造成永久损伤）。` +
        `生成配置：${init}（之后重启 pi）`
      );
    case "unknown":
      return (
        `本目录没有 .encoding-converter.json，而该文件既不是合法 UTF-8、也不能被任何候选编码无损解出` +
        `（可能是 EUC-JP 之外的生僻编码、已被截断、或本就是二进制）。` +
        `pi 内置 read 会静默给出替换字符，**不会报错** —— 别把这份内容当真实文本写回。` +
        `先画像确认：node <扩展目录>/tools/scan-encoding.mjs <目录>`
      );
    case "utf16le":
    case "utf16be":
      return (
        `本目录没有 .encoding-converter.json，而该文件是 ${encoding}（带 BOM）。` +
        `pi 内置 read 按 UTF-8 解码会得到夹杂 NUL 的乱码。` +
        `生成配置：${init}（本扩展能正确读写 UTF-16）`
      );
    default:
      return null;
  }
}

export function legacyWriteHintMessage(prevKind: Kind, prevEnc: string, ambiguous = false): string {
  return (
    `⚠ 这次写入把该文件从 ${prevEnc}${ambiguous ? "（候选歧义，字节分不出具体哪种 GB 系）" : ""}` +
    `${prevKind === "unknown" ? "（非 UTF-8、无法解出）" : ""}` +
    `变成了 UTF-8 —— 因为本目录没有 .encoding-converter.json，` +
    `无配置时本扩展刻意不改变 pi 的内置行为（§8 A-1），而 pi 一律按 UTF-8 写。` +
    `这正是本 fork 要防的缺陷 #1。如果不是你有意转码：请立即用 SVN/Git 恢复该文件` +
    `（svn revert <文件> / git checkout -- <文件>），` +
    `然后生成配置并重启 pi：node <扩展目录>/tools/scan-encoding.mjs . --init`
  );
}

async function probeKey(absPath: string, purpose: string): Promise<string | null> {
  try {
    const st = await fsStat(absPath);
    if (!st.isFile() || st.size > PROBE_MAX_BYTES) return null;
    return `${st.mtimeMs}:${st.size}:${purpose}`;
  } catch {
    return null; // 文件不存在（新建）等
  }
}

function remember(absPath: string, key: string): void {
  if (told.size >= CACHE_MAX) told.clear();
  told.set(absPath, key);
}

/** 读链路：`resolveReadPlan` 返回 null（无配置）时调用。只寄存提示，返回 undefined 语义不变。 */
export async function hintOnNoConfigRead(absPath: string, raw: Buffer): Promise<void> {
  const key = await probeKey(absPath, "read");
  if (!key) return;
  if (told.get(absPath) === key) return;
  remember(absPath, key);
  const v = classifyBuffer(raw.subarray(0, PROBE_MAX_BYTES), null);
  if (!HINTABLE.includes(v.kind)) return; // UTF-8 / ASCII / 二进制 / BOM → 安静
  const msg = legacyReadHintMessage(v.kind, v.encoding, v.ambiguous, v.candidates);
  if (msg) pushEncodingNote(absPath, msg);
}

/**
 * 写链路：无配置目录里的写入会被 pi 按 UTF-8 落盘。我们不拦（A-1），但必须说清发生了什么。
 * 只在**文件原本存在且原本不是 UTF-8**时提示。
 */
export async function hintOnNoConfigWrite(absPath: string): Promise<void> {
  const key = await probeKey(absPath, "write");
  if (!key) return;
  if (told.get(absPath) === key) return;
  remember(absPath, key);
  let prev: Buffer;
  try {
    prev = await fsReadFile(absPath);
  } catch {
    return;
  }
  if (prev.length > PROBE_MAX_BYTES) return;
  const v = classifyBuffer(prev, null);
  if (!HINTABLE.includes(v.kind)) return;
  pushEncodingNote(absPath, legacyWriteHintMessage(v.kind, v.encoding, v.ambiguous));
}

/** 供 session_start / reload 清屏，避免跨会话残留 */
export function clearLegacyHints(): void {
  told.clear();
}
