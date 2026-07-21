// test/converter.test.ts
import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import { isGBEncoding, resolveFileEncoding, decodeToUtf8, encodeFromUtf8 } from "../src/encoding/converter";

describe("converter", () => {
  it("isGBEncoding recognizes GB family", () => {
    expect(isGBEncoding("GB18030")).toBe(true);
    expect(isGBEncoding("gbk")).toBe(true);
    expect(isGBEncoding("UTF-8")).toBe(false);
  });

  it("round-trips Chinese text through GB18030", () => {
    const gb = encodeFromUtf8("你好世界", "GB18030");
    expect(decodeToUtf8(gb, "GB18030")).toBe("你好世界");
    // GB18030 bytes differ from UTF-8 bytes
    expect(gb.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });

  it("resolveFileEncoding: config non-GB always UTF-8", () => {
    expect(resolveFileEncoding("GB2312", 0.99, "UTF-8", 0.8)).toBe("UTF-8");
  });

  it("resolveFileEncoding: config GB trusts high-confidence GB detection", () => {
    expect(resolveFileEncoding("GBK", 0.9, "GB18030", 0.8)).toBe("GBK");
  });

  it("resolveFileEncoding: config GB falls back when detection weak/non-GB", () => {
    expect(resolveFileEncoding("UTF-8", 0.99, "GB18030", 0.8)).toBe("GB18030");
    expect(resolveFileEncoding("GBK", 0.5, "GB18030", 0.8)).toBe("GB18030");
    expect(resolveFileEncoding(null, 0, "GB18030", 0.8)).toBe("GB18030");
  });
});
