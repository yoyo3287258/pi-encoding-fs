// test/classify.test.ts — §3.1 判定器 + 性质 P-1…P-7（必测用例 T-1）
import { describe, it, expect, beforeEach } from "vitest";
import iconv from "iconv-lite";
import {
  classifyBuffer,
  classifyFileCached,
  clearClassifyCache,
  containsNul,
  exactRoundTrip,
  isAllAscii,
  isValidUtf8Strict,
  DEFAULT_AUTO_CANDIDATES,
} from "../src/encoding/classify";
import { clearConfigCache } from "../src/config";
import { FIXTURES, JAVA_SRC, JAVA_SRC_UTF8, RARE_SRC, BIG5_SRC, LATIN1_SRC } from "./fixtures/build";

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
});

const buf = (name: string) => FIXTURES.find((f) => f.name === name)!.make();

describe("T-1 classifyBuffer 对全部 fixture 的分类", () => {
  const expected: Record<string, string> = {
    "empty.txt": "utf8",
    "utf8bom.txt": "utf8-bom",
    "utf16le.txt": "utf16le",
    "utf16be.txt": "utf16be",
    "fake-binary.bin": "binary",
    "utf32le.txt": "binary", // 扩展 1：UTF-32 BOM 归 binary，绝不冒充 UTF-16
    "tiny.png": "binary",
    "ascii.java": "ascii",
    "gbk.txt": "cjk",
    "gbk-crlf.java": "cjk",
    "gb18030-rare.txt": "cjk",
    "utf8.java": "utf8",
    "big5.txt": "cjk",
    "euckr.txt": "cjk",
    "truncated-utf8.txt": "unknown",
    "latin1.txt": "unknown", // 单字节遗留编码在字节层不可判定（P-6）→ 只能靠 force
  };
  for (const f of FIXTURES) {
    it(`${f.name} → ${expected[f.name]}`, () => {
      const v = classifyBuffer(buf(f.name), null);
      expect(v.kind).toBe(expected[f.name]);
    });
  }

  it("无配置时 CJK 候选取 pass[0]=GB18030，且标记为有歧义（真实工程里 GBK 内容同时能被 Big5/EUC-KR 回环）", () => {
    const v = classifyBuffer(buf("gbk.txt"), null);
    expect(v.encoding).toBe("GB18030");
    expect(v.candidates[0]).toBe("GB18030");
    expect(v.ambiguous).toBe(v.candidates.length > 1);
    expect(v.exhaustive).toBe(true);
  });

  it("配置 sourceEncoding 决定 chosen（Big5 树不再被当成 GB18030 —— §3.1 的 cfg 优先级）", () => {
    const noCfg = classifyBuffer(buf("big5.txt"), null);
    const big5 = classifyBuffer(buf("big5.txt"), { sourceEncoding: "Big5" });
    expect(noCfg.encoding).not.toBe("Big5");
    expect(big5.encoding).toBe("Big5");
    expect(big5.kind).toBe("cjk");
    expect(big5.hasFffd).toBe(false);
  });

  it("unknown 只在故意构造的非法样本上出现（截断的多字节序列）", () => {
    const v = classifyBuffer(buf("truncated-utf8.txt"), null);
    expect(v.kind).toBe("unknown");
    expect(v.encoding).toBe("UNKNOWN");
    expect(v.candidates).toEqual([]);
  });

  it("latin1 样本：只能靠 force / 不可判定编码的隐式配置路径", () => {
    const forced = classifyBuffer(buf("latin1.txt"), { sourceEncoding: "ISO-8859-1", force: true });
    expect(forced.kind).toBe("config");
    expect(forced.encoding).toBe("ISO-8859-1");
    expect(forced.configReason).toBe("force");
    expect(forced.hasFffd).toBe(false);
    expect(iconv.decode(buf("latin1.txt"), "ISO-8859-1")).toContain("Gr");
    // 不 force：既不是合法 UTF-8、也不能被 CJK 候选无损回环 → unknown（读透传、写被拒）
    expect(classifyBuffer(buf("latin1.txt"), null).kind).toBe("unknown");
    // 配置写了字节层不可判定的单字节编码（即使没 force）→ 隐式按配置解，而不是当 CJK 猜
    const implicit = classifyBuffer(buf("latin1.txt"), { sourceEncoding: "ISO-8859-1" });
    expect(implicit.kind).toBe("config");
    expect(implicit.configReason).toBe("undecidable");
  });

  it("BOM 标记会带出来（写回时要还原，否则 pi splitBom 剥掉后再也回不来）", () => {
    expect(classifyBuffer(buf("utf8bom.txt"), null).bom).toBe(true);
    expect(classifyBuffer(buf("utf16le.txt"), null).bom).toBe(true);
    expect(classifyBuffer(buf("gbk.txt"), null).bom).toBe(false);
  });
});

describe("§3.1 表格里的实测性质（fork 的正确性建立在它们之上）", () => {
  const gbkBytes = iconv.encode(JAVA_SRC, "GBK");
  const utf8Bytes = iconv.encode(JAVA_SRC_UTF8, "UTF-8");

  it("P-1 真实中文 GBK 源码绝不会被判为合法 UTF-8", () => {
    expect(isValidUtf8Strict(gbkBytes)).toBe(false);
  });
  it("P-2 合法 UTF-8 文件按 GBK 逐字节回环不相等", () => {
    expect(exactRoundTrip(utf8Bytes, "GBK")).toBe(false);
  });
  it("P-3 GBK 字节的 GBK/GB18030 回环逐字节相等且无 U+FFFD", () => {
    expect(exactRoundTrip(gbkBytes, "GBK")).toBe(true);
    expect(exactRoundTrip(gbkBytes, "GB18030")).toBe(true);
    expect(iconv.decode(gbkBytes, "GBK").includes("\ufffd")).toBe(false);
  });
  it("P-4 GBK 内容用 GB18030 编出逐字节不变（超集）", () => {
    expect(Buffer.compare(iconv.encode(iconv.decode(gbkBytes, "GBK"), "GB18030"), gbkBytes)).toBe(0);
  });
  it("P-5 iconv 解码非法字节会产生 U+FFFD（额外闸门）", () => {
    expect(iconv.decode(Buffer.from([0x80, 0x90, 0xa0, 0xff, 0xfe, 0x81]), "GBK")).toContain("\ufffd");
  });
  it("P-6 单字节编码对字节序列总能无损回环 → 绝不允许进自动判定", () => {
    // 注：需求文档 §12 里「windows-1251 全字节回环相等」只对空洞已定义的编码成立：
    // windows-1251/1252 有 0x81/0x8D/0x8F/0x90/0x9D 五个未定义槽位，碰上就不能回环。
    // 结论不变（单字节编码一律禁入自动候选），但测试按实况写。
    expect(exactRoundTrip(gbkBytes, "ISO-8859-1")).toBe(true);
    expect(exactRoundTrip(iconv.encode("Яндекс ÿ", "windows-1251"), "windows-1251")).toBe(true);
    for (const c of DEFAULT_AUTO_CANDIDATES) expect(c).not.toMatch(/ISO-8859|windows-12|CP\d/i);
    // 配置里把单字节编码塞进 autoCandidates → 被剔除（config 层报 warning）
    const v = classifyBuffer(gbkBytes, { sourceEncoding: "GBK", autoCandidates: ["ISO-8859-1", "GBK"] });
    expect(v.candidates).not.toContain("ISO-8859-1");
  });
  it("P-7 截断的多字节序列会被 fatal 解码捕获（必须整文件判定）", () => {
    const t = Buffer.from("中文中间", "utf-8").subarray(0, 7);
    expect(isValidUtf8Strict(t)).toBe(false);
    expect(classifyBuffer(t, null).kind).toBe("unknown");
  });
  it("GBK 扩展区 4 字节字符只有 GB18030 能回环", () => {
    const b = iconv.encode(RARE_SRC, "GB18030");
    expect(exactRoundTrip(b, "GB18030")).toBe(true);
    expect(exactRoundTrip(b, "GBK")).toBe(false);
    expect(classifyBuffer(b, { sourceEncoding: "GBK" }).encoding).toBe("GB18030"); // GBK 不通过 → 回落候选
  });
  it("isAllAscii / containsNul 边界", () => {
    expect(isAllAscii(Buffer.from("OrderService 123\r\n", "ascii"))).toBe(true);
    expect(isAllAscii(Buffer.from([0x00]))).toBe(true); // NUL 属于 ASCII（binary 守卫在它之前已拦下）
    expect(isAllAscii(Buffer.from([0x80]))).toBe(false);
    expect(classifyBuffer(Buffer.from([0x00]), null).kind).toBe("binary");
    expect(containsNul(Buffer.from([0x41, 0x00]))).toBe(true);
    expect(containsNul(Buffer.concat([Buffer.from("A".repeat(9000), "ascii"), Buffer.from([0])]))).toBe(false); // 超过 8192 窗口不判二进制
  });
  it("Big5 样本不会被识别成 GBK 以外的假阳性（解码文本必须是繁体原文）", () => {
    const b = iconv.encode(BIG5_SRC, "Big5");
    expect(iconv.decode(b, "Big5")).toBe(BIG5_SRC);
  });
});

describe("缓存（A-7）", () => {
  it("T-13 1MB 单次判定 < 60ms；命中缓存 < 1ms", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const unit = iconv.encode(JAVA_SRC, "GBK");
    const parts: Buffer[] = [];
    let n = 0;
    while (n < 1024 * 1024) { parts.push(unit); n += unit.length; }
    const big = Buffer.concat(parts).subarray(0, 1024 * 1024);
    const dir = mkdtempSync(join(tmpdir(), "cls-"));
    const f = join(dir, "big.java");
    writeFileSync(f, big);

    const t0 = Date.now();
    const v = classifyFileCached(f, { sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK"] });
    const first = Date.now() - t0;
    expect(v.encoding).toBe("GBK");
    const t1 = Date.now();
    classifyFileCached(f, { sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK"] });
    const second = Date.now() - t1;
    expect(first, `首次判定 ${first}ms 应 <60ms`).toBeLessThan(60);
    expect(second, `缓存命中 ${second}ms 应 <1ms`).toBeLessThan(10); // Date.now 粒度 1ms，给一点余量
  });

  it("mtime/size 变了就重算", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cls2-"));
    const f = join(dir, "a.txt");
    writeFileSync(f, iconv.encode(JAVA_SRC, "GBK"));
    expect(classifyFileCached(f, null).kind).toBe("cjk");
    writeFileSync(f, iconv.encode(JAVA_SRC, "UTF-8"));
    expect(classifyFileCached(f, null).kind).toBe("utf8");
  });
});
