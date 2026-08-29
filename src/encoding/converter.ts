// src/encoding/converter.ts
// 编码名规范化 + 编解码原语 + 不可映射字符检测（闸门 1 的底层能力）。
// 本文件不做任何「猜编码」的工作 —— 判定在 classify.ts。
import iconv from "iconv-lite";

/** 配置里写的编码名不被 iconv-lite 支持时抛出（响亮失败，而不是静默按 UTF-8 处理）。 */
export class UnsupportedEncodingError extends Error {
  constructor(public readonly label: string) {
    super(
      `不支持的编码 "${label}"：iconv-lite 没有这个编码。` +
        `常见可用名：UTF-8 / GB18030 / GBK / GB2312 / Big5 / Shift_JIS / EUC-KR / EUC-JP / ` +
        `ISO-8859-1 / windows-1252 / UTF-16LE / UTF-16BE / UTF-32LE。`,
    );
    this.name = "UnsupportedEncodingError";
  }
}

/** 判定器允许自动猜测的多字节编码（§3.1：单字节编码永不入候选 —— 性质 P-6）。 */
export const AUTO_CJK_CANDIDATES = [
  "GB18030",
  "GBK",
  "GB2312",
  "Big5",
  "Shift_JIS",
  "EUC-KR",
  "EUC-JP",
] as const;

/** 常见别名 → iconv-lite 的规范名（大小写/连字符不敏感）。 */
const ALIASES: Record<string, string> = {
  UTF8: "UTF-8",
  "UTF-8": "UTF-8",
  "UNICODE-1-1-UTF-8": "UTF-8",
  "UTF-16": "UTF-16LE", // 无 BOM 的 "UTF-16" 在 Windows 工具链里几乎都是 LE
  UTF16: "UTF-16LE",
  "UTF-16LE": "UTF-16LE",
  UCS2LE: "UTF-16LE",
  "UTF-16BE": "UTF-16BE",
  UCS2BE: "UTF-16BE",
  "UTF-32LE": "UTF-32LE",
  "UTF-32BE": "UTF-32BE",
  GB18030: "GB18030",
  GBK: "GBK",
  CP936: "GBK",
  MS936: "GBK",
  "X-CP936": "GBK",
  GB2312: "GB2312",
  "EUC-CN": "GB2312",
  CP937: "GB2312",
  BIG5: "Big5",
  "BIG-5": "Big5",
  CP950: "Big5",
  "MS-950": "Big5",
  "SHIFT-JIS": "Shift_JIS",
  SJIS: "Shift_JIS",
  CP932: "Shift_JIS",
  "X-SJIS": "Shift_JIS",
  "EUC-KR": "EUC-KR",
  CP949: "EUC-KR",
  UHC: "EUC-KR",
  "EUC-JP": "EUC-JP",
  "EUCJP-MS": "EUC-JP",
  "ISO-8859-1": "ISO-8859-1",
  LATIN1: "ISO-8859-1",
  "ISO8859-1": "ISO-8859-1",
  CP819: "ISO-8859-1",
  "ISO-8859-2": "ISO-8859-2",
  "ISO-8859-5": "ISO-8859-5",
  "ISO-8859-7": "ISO-8859-7",
  "ISO-8859-9": "ISO-8859-9",
  "ISO-8859-15": "ISO-8859-15",
  "WINDOWS-1250": "windows-1250",
  "WINDOWS-1251": "windows-1251",
  "WINDOWS-1252": "windows-1252",
  CP1252: "windows-1252",
  CP1251: "windows-1251",
  CP1250: "windows-1250",
  KOI8R: "KOI8-R",
  KOI8U: "KOI8-U",
  CP437: "CP437",
  CP850: "CP850",
  CP852: "CP852",
  MACINTOSH: "MACINTOSH",
  "IBM866": "CP866",
  ASCII: "US-ASCII",
  "US-ASCII": "US-ASCII",
};

/** 已解析编码的规范化结果（保留原串以便 iconv 处理未知别名）。 */
export function normalizeEncoding(label: string | undefined | null): string {
  const raw = String(label ?? "").trim();
  if (!raw) return "UTF-8";
  const key = raw.toUpperCase().replace(/_/g, "-").replace(/\s+/g, "");
  const alias = ALIASES[key] ?? ALIASES[key.replace(/-/g, "")];
  const candidate = alias ?? raw;
  if (!iconv.encodingExists(candidate)) {
    // 再试一次去掉连字符的形式（iconv 自带别名表已相当全，这里只是兜底）。
    const loose = candidate.replace(/-/g, "");
    if (iconv.encodingExists(loose)) return loose;
    throw new UnsupportedEncodingError(raw);
  }
  return candidate;
}

export function isSupportedEncoding(label: string): boolean {
  try {
    normalizeEncoding(label);
    return true;
  } catch {
    return false;
  }
}

const GB_RE = /^(GB18030|GBK|GB2312|EUC-?CN|CP936|CP937|GBK-?EUIPO)$/i;

/** GB 家族判定：BOM 规则与「自动升级到 GB18030」策略要用它。 */
export function isGBEncoding(encoding: string): boolean {
  const n = safeNormalize(encoding);
  return GB_RE.test(n) || n.toUpperCase().includes("GB");
}

function safeNormalize(label: string): string {
  try {
    return normalizeEncoding(label);
  } catch {
    return label;
  }
}

/**
 * 单字节（codepage 全 256 槽位）编码：对任意字节序列都能「无损回环」，
 * 因此绝对不允许进自动判定（性质 P-6），只能由配置 `force` 指定。
 */
const SINGLE_BYTE_RE =
  /^(ISO-8859-\d+|ISO-8859-1[0-6]|windows-125\d|windows-1250|CP125\d|CP437|CP850|CP852|CP855|CP866|CP874|KOI8-[RU]|MACINTOSH|IBM\d{3,4}|US-ASCII|LATIN\d)$/i;
export function isSingleByteEncoding(encoding: string): boolean {
  const n = safeNormalize(encoding);
  return SINGLE_BYTE_RE.test(n) || SINGLE_BYTE_RE.test(n.replace(/-/g, ""));
}

/** 转义序列类编码：逐字节回环判定在原理上不成立（§7 Non-Goals）。 */
const STATEFUL_RE = /^(ISO-2022-|EBCDIC|CS|\d{4}$)/i;
export function isStatefulEncoding(encoding: string): boolean {
  return STATEFUL_RE.test(safeNormalize(encoding).toUpperCase());
}

export function decodeToUtf8(buffer: Buffer, encoding: string): string {
  return iconv.decode(buffer, encoding);
}

export function encodeFromUtf8(text: string, encoding: string): Buffer {
  return iconv.encode(text, encoding);
}

/**
 * 该编码是否能无损表示 text 的全部码点（闸门 1 的快速路径）。
 * 只做整体探测，不做逐码点校验；false 时再调 unmappableChars 拿明细。
 */
export function canEncodeAll(text: string, encoding: string): boolean {
  const buf = iconv.encode(text, encoding);
  if (!buf.includes(0x3f)) return true; // 没出现 '?' 快速通过
  return iconv.decode(buf, encoding) === text;
}

/**
 * 逐码点找出不可映射字符（§3.3 闸门 1）。`for..of` 走码点，代理对/扩展平面正确。
 * 实测：unmappableChars('注释：张䶇（生僻字）𠀋 扩展C','gbk') = ["䶇","𠀋"]
 *       unmappableChars('OrderService 123\r\n','gbk')          = []   ← 无误报
 */
export function unmappableChars(text: string, encoding: string): string[] {
  const bad: string[] = [];
  for (const ch of text) {
    if (ch === "?") continue; // 本身就是 '?'，无损
    const b = iconv.encode(ch, encoding);
    if (b.includes(0x3f) || iconv.decode(b, encoding) !== ch) {
      if (!bad.includes(ch)) bad.push(ch);
    }
  }
  return bad;
}

export function charListMessage(chars: string[]): string {
  return chars.map((c) => `${c} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
}

/**
 * 把该编码无法表示的码点替换成 Java 风格的 `\uXXXX` 转义（非 BMP 用代理对两次转义）。
 * `unmappable: "escape"` 策略用；对 .java/.js 的字符串字面量是真转义，
 * 对注释/其它文件只是可读的占位文本 —— 因此默认策略仍是 "error"。
 */
export function escapeUnmappable(text: string, encoding: string): string {
  if (canEncodeAll(text, encoding)) return text;
  let out = "";
  for (const ch of text) {
    const b = iconv.encode(ch, encoding);
    const lossy = b.includes(0x3f) || iconv.decode(b, encoding) !== ch;
    if (!lossy) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const hi = 0xd800 + ((cp - 0x10000) >> 10);
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}
