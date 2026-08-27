// test/roundtrip.test.ts — T-2（幂等/无损回环）、T-4（ASCII 文件写中文）、T-7（CRLF 不被双重转换）
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { FIXTURES, JAVA_SRC, JAVA_SRC_UTF8, RARE_SRC } from "./fixtures/build";

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt-"));
});

/** 每个 fixture 用它「自己的编码」当配置，read→write 后必须逐字节相等。 */
describe("T-2 read→write 幂等/无损（同编码配置）", () => {
  const cases: { name: string; cfg: Record<string, unknown> }[] = [
    { name: "gbk.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "gbk-crlf.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "gb18030-rare.txt", cfg: { sourceEncoding: "GB18030", writeEncoding: "GB18030" } },
    { name: "utf8.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } }, // GBK 配置里读 UTF-8 → 保护规则必须让它逐字节不变
    { name: "utf8bom.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } }, // 同上，且 BOM 必须保留
    { name: "utf16le.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } }, // UTF-16 保持原样
    { name: "utf16be.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "ascii.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } }, // 纯 ASCII：读写等价
    { name: "big5.txt", cfg: { sourceEncoding: "Big5", writeEncoding: "Big5" } },
    { name: "euckr.txt", cfg: { sourceEncoding: "EUC-KR", writeEncoding: "EUC-KR" } },
    { name: "latin1.txt", cfg: { sourceEncoding: "ISO-8859-1", overrides: [{ pattern: "*", encoding: "ISO-8859-1", force: true }] } },
    { name: "empty.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
  ];
  for (const c of cases) {
    it(`${c.name}：内容不变时写出字节必须与原文件完全相等`, async () => {
      const f = FIXTURES.find((x) => x.name === c.name)!;
      putConfig(root, c.cfg);
      const p = join(root, c.name);
      const original = f.make();
      writeFileSync(p, original);
      const ops = makeReadOperations();
      const wops = makeWriteOperations();
      const text = (await ops.readFile(p)).toString("utf-8");
      await wops.writeFile(p, text);
      const after = readFileSync(p);
      expect(after.equals(original)).toBe(true);
    });
  }
});

describe("T-2b GBK 树里的混合编码（OAWSSMS 真实形态）", () => {
  it("GBK 配置 + writeEncoding=GB18030：既有 GBK 文件写出后逐字节不变（性质 P-4）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "A.java");
    const original = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, original);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await makeWriteOperations().writeFile(p, text);
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("反向（GB18030 树降级写 GBK）必须被拒：4 字节扩展区字符会被静默改成 '?'", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GBK" });
    const p = join(root, "Rare.java");
    const original = iconv.encode(RARE_SRC, "GB18030");
    writeFileSync(p, original);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await expect(makeWriteOperations().writeFile(p, text)).rejects.toThrow(/无损|回环|force/);
    expect(readFileSync(p).equals(original)).toBe(true); // 被拒后磁盘不能被改
  });
});

describe("T-4 ASCII 文件写入中文 → 按项目编码写（不是 UTF-8）", () => {
  it("GBK 项目里给纯 ASCII 的 .java 加中文注释 → 磁盘必须是 GBK 字节", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Ascii.java");
    writeFileSync(p, Buffer.from("public class Ascii {}\r\n", "ascii"));
    await makeWriteOperations().writeFile(p, "public class Ascii {\r\n    // 中文注释\r\n}\r\n");
    const bytes = readFileSync(p);
    expect(isValidUtf8(bytes)).toBe(false); // 真的不是 UTF-8 了
    expect(iconv.decode(bytes, "GBK")).toContain("中文注释");
    expect(Buffer.compare(bytes, iconv.encode("public class Ascii {\r\n    // 中文注释\r\n}\r\n", "GBK"))).toBe(0);
  });

  it("UTF-8 项目（sourceEncoding=UTF-8）里的纯 ASCII 文件写中文 → UTF-8", async () => {
    putConfig(root, { sourceEncoding: "UTF-8", writeEncoding: "UTF-8" });
    const p = join(root, "Ascii.java");
    writeFileSync(p, Buffer.from("class A{}\n", "ascii"));
    await makeWriteOperations().writeFile(p, "class A{ /* 中文 */ }\n");
    expect(readFileSync(p).equals(Buffer.from("class A{ /* 中文 */ }\n", "utf-8"))).toBe(true);
  });
});

describe("T-6（写部分）UTF-8-BOM 文件在 GB 配置下经 pi 的 edit 全链路", () => {
  it("pi 剔了 BOM 再交给我们写回 → BOM 必须被还原，且绝不出现 0x3F", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "BomE2e.txt");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("标题：TEST-1\r\n", "utf-8")]);
    writeFileSync(p, original);

    // ① pi 的 read/edit：拿到含 BOM 的文本后用 splitBom 剥掉 BOM（模拟 dist/core/tools/utils/text.js）
    const raw = await makeReadOperations().readFile(p);
    const full = raw.toString("utf-8");
    const bom = full.charCodeAt(0) === 0xfeff;
    const content = bom ? full.slice(1) : full;
    expect(bom).toBe(true);

    // ② 改一个纯 ASCII 片段，再交给 ops.writeFile
    await makeWriteOperations().writeFile(p, content.replace("TEST-1", "TEST-2") + "追加一行\r\n");

    const after = readFileSync(p);
    expect(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true); // BOM 还在
    expect(after.includes(0x3f)).toBe(false); // 磁盘上没有任何 '?'（缺陷 4 的现场）
    const text = after.subarray(3).toString("utf-8");
    expect(text).toContain("标题：TEST-2");
    expect(text).toContain("追加一行");
    expect(after.length).toBeLessThan(original.length + 60); // 没有 U+FFFD 式的膨胀
  });

  it("GBK 文件里写生僻字：P1 先保证不会默默写成 0x3F（闸门 1 在 P2 接入后改为报错）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Gb.java");
    writeFileSync(p, iconv.encode("class A{}\r\n", "GBK"));
    await makeWriteOperations().writeFile(p, "class A{ /* 注释 䶇 */ }\r\n");
    const after = readFileSync(p);
    expect(after.includes(0x3f)).toBe(false); // 没有 '?'：字符被 GB18030 完整保住了
    expect(iconv.decode(after, "GB18030")).toContain("䶇");
  });
});

describe("T-7 行尾保真（含「pi 已恢复过一次」的双重恢复幂等性）", () => {
  it("CRLF 的 GBK 文件写回仍是 CRLF，且不出现 \\r\\r\\n", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Crlf.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    // pi 的 edit 在调用 ops.writeFile 之前已经自己恢复过一次行尾 → 我们拿到的就是 CRLF 文本
    const piRestored = text.replace(/\r?\n/g, "\r\n");
    expect(piRestored).not.toContain("\r\r\n");
    await makeWriteOperations().writeFile(p, piRestored);
    const out = readFileSync(p).toString("binary");
    expect(out).not.toMatch(/\r\r/);
    expect(out.split("\r\n").length).toBeGreaterThan(1);
    expect(iconv.decode(readFileSync(p), "GBK")).toBe(piRestored);
  });

  it("LF 结尾的 GBK java（OAWSSMS 里有 61 个）写回仍是 LF", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Lf.java");
    const lfOnly = iconv.encode(JAVA_SRC.replace(/\r\n/g, "\n"), "GBK");
    writeFileSync(p, lfOnly);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await makeWriteOperations().writeFile(p, text.replace("=85.5", "=90.0"));
    const after = readFileSync(p);
    expect(after.includes(0x0d)).toBe(false); // 没被“顺手”改成 CRLF
    expect(after.equals(iconv.encode(JAVA_SRC.replace(/\r\n/g, "\n").replace("=85.5", "=90.0"), "GBK"))).toBe(true);
    expect(iconv.decode(after, "GBK")).toContain("报警阈值=90.0");
  });

  it("无配置目录：writeFile 的行为必须与不装扩展逐字节一致（透传，不改行尾）", async () => {
    const p = join(root, "plain.txt");
    const content = "line1\r\nline2\n";
    writeFileSync(p, Buffer.from(content, "utf-8"));
    await makeWriteOperations().writeFile(p, content + "line3\r\n");
    expect(readFileSync(p).equals(Buffer.from(content + "line3\r\n", "utf-8"))).toBe(true);
  });
});

function isValidUtf8(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}
