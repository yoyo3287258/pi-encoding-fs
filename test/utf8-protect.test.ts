// test/utf8-protect.test.ts — T-3：GBK 配置目录里的真 UTF-8 文件不能被毁（头号回归点）
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig, writeTree } from "./helpers/tree";
import { legacyJavaWebTree, JAVA_SRC, JAVA_SRC_UTF8 } from "./fixtures/build";

const isUtf8 = (b: Buffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

describe("T-3 UTF-8 保护（§3.2 🛡️ 规则 / §2 缺陷 1 的镜像事故）", () => {
  let root: string;
  beforeEach(() => {
    clearConfigCache();
    clearClassifyCache();
    root = mkdtempSync(join(tmpdir(), "protect-"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
  });

  it("编辑 ASCII 片段 =85.5 → =90.0：UTF-8 文件仍是合法 UTF-8，中文仍可读", async () => {
    const p = join(root, "Mixed.java");
    const original = Buffer.from(JAVA_SRC_UTF8, "utf-8");
    writeFileSync(p, original);

    const r = makeReadOperations();
    const w = makeWriteOperations();
    const text = (await r.readFile(p)).toString("utf-8");
    expect(text).toContain("报警阈值=85.5");
    await w.writeFile(p, text.replace("=85.5", "=90.0"));

    const after = readFileSync(p);
    expect(isUtf8(after)).toBe(true); // 仍是 UTF-8
    expect(after.toString("utf-8")).not.toContain("\ufffd\ufffd"); // 没有 U+FFFD 泛滥
    expect(after.length).toBeLessThan(original.length + 60); // 没有从 46B 膨胀到 94B 那种事故
    expect(after.toString("utf-8")).toContain("温控器A"); // 原中文还在
    expect(after.toString("utf-8")).toContain("=90.0"); // 改动生效
    // 关键：绝没有被按 GBK 重写
    expect(Buffer.compare(after, iconv.encode(after.toString("utf-8"), "GBK"))).not.toBe(0);
  });

  it("同一目录里 GBK 文件与 UTF-8 文件同时被正确读出（上游只能对其中一半正确）", async () => {
    const g = join(root, "Gbk.java");
    const u = join(root, "Utf8.java");
    writeFileSync(g, iconv.encode(JAVA_SRC, "GBK"));
    writeFileSync(u, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const r = makeReadOperations();
    const fromGbk = (await r.readFile(g)).toString("utf-8");
    const fromUtf8 = (await r.readFile(u)).toString("utf-8");
    expect(fromGbk).toContain("温控器A");
    expect(fromUtf8).toContain("温控器A");
    expect(fromGbk.replace(/\r\n/g, "\n")).toBe(fromUtf8.replace(/\r\n/g, "\n"));
    expect(fromGbk).not.toContain("锟斤拷");
  });

  it("protectUtf8:false 也不允许在没有 force 时静默转换（§3.2 只在 force 时放行）", async () => {
    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", protectUtf8: false });
    const p = join(root, "NoProtect.java");
    writeFileSync(p, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const text = (await r.readFile(p)).toString("utf-8");
    await w.writeFile(p, text.replace("=85.5", "=90.0"));
    const after = readFileSync(p);
    // protectUtf8=false 是显式信号 → 允许转换，但必须真的转成 GBK（不是半途而废产生 U+FFFD）
    expect(isUtf8(after)).toBe(false);
    expect(iconv.decode(after, "GBK")).toContain("温控器A");
  });
});

describe("OAWSSMS 真实形态的混合树（src/*/java 里 GBK 与 UTF-8 同目录混住）", () => {
  let root = "";
  let paths: Map<string, string> = new Map();
  beforeEach(() => {
    clearConfigCache();
    clearClassifyCache();
    root = mkdtempSync(join(tmpdir(), "tree-"));
    paths = writeTree(join(root, "tree"), legacyJavaWebTree(join(root, "tree")).files);
  });

  const textFiles = () =>
    [...paths.keys()].filter((f) => !f.endsWith(".encoding-converter.json") && !f.endsWith(".dsv"));

  it("每个文件 read→write（内容不变）都逐字节无损", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const broken: string[] = [];
    for (const rel of textFiles()) {
      const abs = paths.get(rel)!;
      const before = readFileSync(abs);
      const out = await r.readFile(abs);
      await w.writeFile(abs, out.toString("utf-8"));
      const after = readFileSync(abs);
      if (!after.equals(before)) broken.push(`${rel} (${before.length}B → ${after.length}B)`);
    }
    expect(broken).toEqual([]);
  });

  it("每个文件编辑一个 ASCII 片段后，磁盘编码类别不变（UTF-8 仍 UTF-8，GBK 仍 GBK）", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const bad: string[] = [];
    const edited: string[] = [];
    for (const rel of textFiles()) {
      const abs = paths.get(rel)!;
      const before = readFileSync(abs);
      const text = (await r.readFile(abs)).toString("utf-8");
      if (!text.includes("=85.5")) continue;
      edited.push(rel);
      await w.writeFile(abs, text.replace("=85.5", "=90.0"));
      const after = readFileSync(abs);
      if (Math.abs(after.length - before.length) > 2) bad.push(`${rel}: 尺寸异常 ${before.length}B→${after.length}B`);
      if (isUtf8(before) && !isUtf8(after)) bad.push(`${rel}: UTF-8 文件被转码了`);
      if (!isUtf8(before) && isUtf8(after) && after.some((x) => x > 0x7f)) bad.push(`${rel}: GBK 文件变成了 UTF-8`);
    }
    expect(bad).toEqual([]);
    // 至少真的验证过几个文件，否则这个用例是空跑的
    expect(edited.length).toBeGreaterThanOrEqual(4);
  });

  it("二进制样本（.dsv 含 NUL）：读透传、写被闸门 3 拒绝", async () => {
    const abs = paths.get("db/oracle.dsv")!;
    const before = readFileSync(abs);
    const r = makeReadOperations();
    const out = await r.readFile(abs);
    expect(out.equals(before)).toBe(true); // 未被转码
    await expect(makeWriteOperations().writeFile(abs, "text\n")).rejects.toThrow(/二进制|binary/);
    expect(readFileSync(abs).equals(before)).toBe(true);
  });

  it("JSP：UTF-8 与 GBK 页面共存，二者中文都能正确读出，写回后 pageEncoding 声明仍与磁盘一致", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const cases = [
      ["WebContent/pages/login.jsp", "GBK", "登录名"],
      ["WebContent/pages/msg/wxmessagefeedback.jsp", "UTF-8", "回复微信消息"],
    ] as const;
    const bad: string[] = [];
    for (const [rel, , needle] of cases) {
      const abs = paths.get(rel)!;
      const text = (await r.readFile(abs)).toString("utf-8");
      if (!text.includes(needle)) bad.push(`${rel} 未读出 ${needle}`);
      await w.writeFile(abs, text + "<%-- touched --%>\r\n");
      const after = readFileSync(abs);
      const declared = /pageEncoding="([^"]+)"/i.exec(after.toString("latin1"))?.[1] ?? "(无声明)";
      const declaredUtf8 = /utf-?8/i.test(declared);
      if (isUtf8(after) !== declaredUtf8) bad.push(`${rel}: 声明 pageEncoding=${declared} 但磁盘 ${isUtf8(after) ? "是" : "不是"} UTF-8`);
    }
    expect(bad).toEqual([]);
  });
});
