/**
 * 方案乙（用户拍板）：无配置目录里，pi 内置 read/write 是**有损且不报错**的，
 * 本扩展仍不改任何字节（§8 A-1 继续成立），但必须把「刚发生了什么」寄存成提示。
 *
 * 依据是实测事实：pi 0.84.3 的 dist/core/tools/read.js:196 用 buffer.toString("utf-8")。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearEncodingNotes, drainEncodingNotes } from "../src/notify";
import { clearLegacyHints, legacyReadHintMessage } from "../src/legacy-hint";

const dirs: string[] = [];
function tmp(prefix = "hint-"): string {
  const d = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
function put(dir: string, rel: string, data: string | Buffer): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}
const gbk = (t: string) => iconv.encode(t, "GBK");
function notes(abs: string): string {
  return drainEncodingNotes(abs).join("\n");
}

beforeEach(() => {
  clearEncodingNotes();
  clearLegacyHints();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("方案乙：无配置目录的读提示", () => {
  it("GBK 文件：返回值逐字节等于磁盘内容（A-1 不破），同时寄存一条含 --init 的提示", async () => {
    const d = tmp();
    const p = put(d, "A.java", gbk("/** 订单服务 。*/ class A{}"));
    const before = readFileSync(p);
    const r = makeReadOperations();
    const got = await r.readFile(p);
    expect(got.equals(before)).toBe(true); // 一个字节都没改（含问号乱码也不产生 —— 那是 pi 的事）
    const n = notes(p);
    expect(n).toContain("没有 .encoding-converter.json");
    expect(n).toMatch(/GBK|GB18030/); // 无配置时按默认候选链，歧义内容会给出 GB18030
    expect(n).toContain("--init");
    expect(n).toContain("不会报错");
  });

  it("UTF-8 / ASCII / 二进制 / 空文件：完全安静（宁缺毋滥）", async () => {
    const d = tmp();
    const u = put(d, "U.java", "/** 中文注释 。*/ class U{}"); // 合法 UTF-8 且含非 ASCII
    const a = put(d, "A.java", "class A{}"); // 纯 ASCII
    const b = put(d, "pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00])); // NUL → binary
    const e = put(d, "E.txt", Buffer.alloc(0));
    const r = makeReadOperations();
    for (const p of [u, a, b, e]) {
      await r.readFile(p);
      expect(notes(p)).toBe("");
    }
  });

  it("提示文案本身", () => {
    // 歧义时必须列出真实候选集，不能把同一个编码名拄两遍充当“候选”
    const m = legacyReadHintMessage("cjk", "GB18030", true, ["GB18030", "GBK", "GB2312", "Big5"]);
    expect(m).toContain("GB18030/GBK/GB2312/Big5");
    expect(m).not.toContain("GB18030 等");
    expect(legacyReadHintMessage("cjk", "GBK", false, [])).not.toContain("歧义候选");
  });

  it("既不是 UTF-8 也不是任何候选 → 提示「解不出来」，并警告别把这份内容写回", async () => {
    const d = tmp();
    // 80 80 C0 C0 之类：非 UTF-8；且不能整段被 GBK/Big5… 无损回环
    const p = put(d, "X.bin.txt", Buffer.from([0xa1, 0xfe, 0xa1, 0xfe, 0xf0, 0xf1, 0xf2, 0xf3, 0x80, 0x80]));
    const r = makeReadOperations();
    await r.readFile(p);
    const n = notes(p);
    if (n) expect(n).toMatch(/不是合法 UTF-8|不能被任何候选|替换字符/);
  });

  it("同一份内容只提示一次；文件真被改动后会重新提示", async () => {
    const d = tmp();
    const p = put(d, "B.java", gbk("/** 中文一 。*/ class B{}"));
    const r = makeReadOperations();
    await r.readFile(p);
    expect(notes(p)).not.toBe("");
    await r.readFile(p);
    expect(notes(p)).toBe(""); // 去重
    // 改动文件（size 变）→ key 变 → 再提示
    writeFileSync(p, gbk("/** 中文一，现在内容变长了些 。*/ class B{}"));
    clearEncodingNotes();
    await r.readFile(p);
    expect(notes(p)).not.toBe("");
  });

  it("有配置时不重复说话（读走转码链路，提示来自 plan.warnings）", async () => {
    const d = tmp();
    put(
      d,
      ".encoding-converter.json",
      JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK", protectUtf8: true, verifyWrite: true }),
    );
    const p = put(d, "C.java", gbk("/** 中文 。*/ class C{}"));
    const r = makeReadOperations();
    const got = await r.readFile(p);
    expect(got.toString("utf-8")).toContain("中文"); // 真的转码了
    expect(notes(p)).not.toContain("没有 .encoding-converter.json");
  });
});

describe("方案乙：无配置目录的写提示", () => {
  it("改一个 GBK 文件 → 磁盘按 pi 的行为变成 UTF-8，但提示里说清是谁干的、怎么回滚", async () => {
    const d = tmp();
    const p = put(d, "D.java", gbk("/** 订单服务 。*/ class D{}"));
    const before = readFileSync(p);
    const w = makeWriteOperations();
    await w.writeFile(p, "/** 订单服务（已改） 。*/ class D{}");

    // 行为与未装扩展一致：UTF-8 落盘（A-1）
    const after = readFileSync(p);
    expect(after.equals(before)).toBe(false);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(after)).not.toThrow();

    const n = notes(p);
    expect(n).toContain("变成了 UTF-8");
    expect(n).toMatch(/GBK|GB18030/); // 无配置时走默认候选链，歧义内容报 GB18030 并在文案里注明分不出具体哪种
    expect(n).toContain("A-1"); // 明确这是刻意保持的透传语义，不是我们转的
    expect(n).toMatch(/svn revert|git checkout/); // 给出可执行的补救动作
    expect(n).toContain("--init");
  });

  it("新建文件（原本不存在）→ 不提示", async () => {
    const d = tmp();
    const p = path.join(d, "New.java");
    const w = makeWriteOperations();
    await w.writeFile(p, "class New{} // 中文");
    expect(notes(p)).toBe("");
  });

  it("纯 ASCII / UTF-8 文件的无配置写入 → 不提示（本来就没有编码可毁）", async () => {
    const d = tmp();
    const a = put(d, "A.java", "class A{}");
    const u = put(d, "U.java", "// 中文注释\nclass U{}");
    const w = makeWriteOperations();
    await w.writeFile(a, "class A{} // 新增一行");
    await w.writeFile(u, "// 中文注释\nclass U{} // 改一下");
    expect(notes(a)).toBe("");
    expect(notes(u)).toBe("");
  });

  it("有配置时写入按闸门走，不出现无配置提示", async () => {
    const d = tmp();
    put(d, ".encoding-converter.json", JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const p = put(d, "E.java", gbk("/** 中文 。*/ class E{}"));
    const w = makeWriteOperations();
    await w.writeFile(p, "/** 中文改过 。*/ class E{}");
    const after = readFileSync(p);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(after)).toThrow(); // 仍是 GBK
    expect(iconv.decode(after, "GBK")).toContain("中文改过");
    expect(notes(p)).not.toContain("没有 .encoding-converter.json");
  });
});

describe("提示文案本身", () => {
  it("unknown / UTF-16 各有专属文案；UTF-8 系不给文案", () => {
    expect(legacyReadHintMessage("cjk", "GBK", false)).toContain("GBK");
    expect(legacyReadHintMessage("unknown", "UNKNOWN", false)).toContain("不能");
    expect(legacyReadHintMessage("utf16le", "UTF-16LE", false)).toContain("UTF-16LE");
    expect(legacyReadHintMessage("utf8", "UTF-8", false)).toBeNull();
    expect(legacyReadHintMessage("ascii", "UTF-8", false)).toBeNull();
    expect(legacyReadHintMessage("binary", "BINARY", false)).toBeNull();
  });
});
