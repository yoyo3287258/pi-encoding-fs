// test/converter.test.ts — 编码原语（P1 重写版）
// 迁移说明：上游这里的 `resolveFileEncoding(detected, confidence, …)` 4 个用例测的是
// 「chardet 置信度阈值」决策，该函数随 §2 缺陷 1 的修复一起删除；等价意图现在由
// test/classify.test.ts（字节判定链）+ test/resolve.test.ts（配置优先级）覆盖。
import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import {
  canEncodeAll,
  charListMessage,
  decodeToUtf8,
  encodeFromUtf8,
  isGBEncoding,
  isSingleByteEncoding,
  isStatefulEncoding,
  isSupportedEncoding,
  normalizeEncoding,
  unmappableChars,
  UnsupportedEncodingError,
} from "../src/encoding/converter";

describe("normalizeEncoding", () => {
  it("常见别名收敛到 iconv 规范名", () => {
    expect(normalizeEncoding("utf8")).toBe("UTF-8");
    expect(normalizeEncoding("UTF-8")).toBe("UTF-8");
    expect(normalizeEncoding("gb18030")).toBe("GB18030");
    expect(normalizeEncoding("cp936")).toBe("GBK");
    expect(normalizeEncoding("euc-cn")).toBe("GB2312");
    expect(normalizeEncoding("big-5")).toBe("Big5");
    expect(normalizeEncoding("sjis")).toBe("Shift_JIS");
    expect(normalizeEncoding("latin1")).toBe("ISO-8859-1");
    expect(normalizeEncoding("cp1252")).toBe("windows-1252");
    expect(normalizeEncoding(undefined)).toBe("UTF-8");
  });
  it("不认识的编码名抛 UnsupportedEncodingError（绝不静默按 UTF-8 处理）", () => {
    expect(() => normalizeEncoding("NOT-A-CODEC")).toThrow(UnsupportedEncodingError);
    expect(isSupportedEncoding("GBK")).toBe(true);
    expect(isSupportedEncoding("EBCDIC-CP-US")).toBe(false);
  });
});

describe("编码族判定", () => {
  it("isGBEncoding recognizes GB family", () => {
    expect(isGBEncoding("GB18030")).toBe(true);
    expect(isGBEncoding("gbk")).toBe(true);
    expect(isGBEncoding("UTF-8")).toBe(false);
    expect(isGBEncoding("Big5")).toBe(false);
  });
  it("单字节编码（只能 force，性质 P-6）", () => {
    expect(isSingleByteEncoding("ISO-8859-1")).toBe(true);
    expect(isSingleByteEncoding("windows-1251")).toBe(true);
    expect(isSingleByteEncoding("GBK")).toBe(false);
    expect(isSingleByteEncoding("UTF-8")).toBe(false);
  });
  it("转义序列/状态型编码不进自动判定（§7 Non-Goals）", () => {
    expect(isStatefulEncoding("ISO-2022-JP")).toBe(true);
    expect(isStatefulEncoding("GBK")).toBe(false);
  });
});

describe("编解码", () => {
  it("round-trips Chinese text through GB18030", () => {
    const gb = encodeFromUtf8("你好世界", "GB18030");
    expect(decodeToUtf8(gb, "GB18030")).toBe("你好世界");
    expect(gb.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });
  it("任意 iconv 编码都能用（修 §2 缺陷 2）", () => {
    expect(decodeToUtf8(encodeFromUtf8("Ünïcødé", "ISO-8859-1"), "ISO-8859-1")).toBe("Ünïcødé");
    expect(decodeToUtf8(encodeFromUtf8("한국어", "EUC-KR"), "EUC-KR")).toBe("한국어");
    expect(decodeToUtf8(encodeFromUtf8("日本語", "Shift_JIS"), "Shift_JIS")).toBe("日本語");
    expect(decodeToUtf8(encodeFromUtf8("繁體", "Big5"), "Big5")).toBe("繁體");
  });
});

describe("闸门 1 的底层能力（§3.3）", () => {
  it("unmappableChars 找出 GBK 无法表示的码点，且对纯 ASCII 无误报", () => {
    expect(unmappableChars("注释：张䶇（生僻字）𠀋 扩展C", "gbk")).toEqual(["䶇", "𠀋"]);
    expect(unmappableChars("注释：张䶇（生僻字）𠀋 扩展C", "gb18030")).toEqual([]);
    expect(unmappableChars("OrderService 123\r\n", "gbk")).toEqual([]);
    expect(charListMessage(["䶇", "𠀋"])).toBe("䶇 U+4D87, 𠀋 U+2000B"); // 实测：需求文档 §6.2 T-5 写的 U+4DB7 是笔误
  });
  it("canEncodeAll 的快速路径与逐码点结果一致", () => {
    expect(canEncodeAll("普通中文", "GBK")).toBe(true);
    expect(canEncodeAll("有 䶇 在里面", "GBK")).toBe(false);
    expect(canEncodeAll("问号?本身不算丢字", "GBK")).toBe(true);
  });
  it("实测缺陷 3/4 的现场：iconv 把不可映射字符写成 0x3F", () => {
    expect(iconv.encode("䶇", "gbk")[0]).toBe(0x3f);
    expect(iconv.encode("\ufeff标题：测试\n", "gbk")[0]).toBe(0x3f);
  });
});
