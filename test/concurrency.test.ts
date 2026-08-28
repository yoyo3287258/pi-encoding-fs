// test/concurrency.test.ts — §6.2 T-12：并发写同一文件不得产生竞态损坏
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes } from "../src/notify";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  root = mkdtempSync(join(tmpdir(), "conc-"));
});

describe("T-12 并发写同一文件", () => {
  it("20 个并发「读+改+写」同一个 GBK 文件：结束时内容必是某一次写入的完整结果，且仍是合法 GBK", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Conc.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    const wr = makeWriteOperations();
    const rd = makeReadOperations();
    const wanted: string[] = [];
    for (let i = 0; i < 20; i++) {
      wanted.push(JAVA_SRC.replace("报警阈值=85.5", `报警阈值=${85 + i / 10}`));
    }
    await Promise.all(wanted.map((text) => wr.writeFile(p, text)));
    const finalBytes = readFileSync(p);
    const finalText = iconv.decode(finalBytes, "GBK");
    // 1) 没有半截文件、没有交错：必须是某一次写入的完整文本
    expect(wanted).toContain(finalText);
    // 2) 仍然是合法 GBK（未编辑部分完好：CRLF 与结尾都在）
    expect(finalText.endsWith("}\r\n")).toBe(true);
    expect(finalBytes.includes(0x3f)).toBe(false);
    // 3) 闸门 2 的回读自校验没有报错（即每次写都自洽）
    expect((await rd.readFile(p)).toString("utf-8")).toBe(finalText);
    // 4) 没有留下临时文件
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root).filter((f) => f.includes(".encfs.tmp"))).toEqual([]);
  });

  it("并发写不同文件互不影响（原子替换 + 各自回滚域）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const files = Array.from({ length: 12 }, (_, i) => join(root, `F${i}.java`));
    files.forEach((f, i) => writeFileSync(f, iconv.encode(JAVA_SRC.replace("85.5", String(90 + i)), "GBK")));
    const wr = makeWriteOperations();
    await Promise.all(files.map((f, i) => wr.writeFile(f, JAVA_SRC.replace("85.5", String(100 + i)))));
    for (let i = 0; i < files.length; i++) {
      expect(iconv.decode(readFileSync(files[i]), "GB18030")).toBe(JAVA_SRC.replace("85.5", String(100 + i)));
    }
  });

  it("闸门 2 回滚期间文件始终可读（不会读到半成品）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "RollConc.java");
    const original = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, original);
    const wr = makeWriteOperations();
    // 制造一次会失败的大写入（目标编码装不下 → 闸门 1 抛错），同时不断读
    const reader = (async () => {
      const seen: number[] = [];
      for (let i = 0; i < 40; i++) {
        seen.push(readFileSync(p).length);
        await new Promise((r) => setImmediate(r));
      }
      return seen;
    })();
    await expect(wr.writeFile(p, "含生僻字 䶇 的内容")).rejects.toThrow(/闸门 1/);
    const lengths = await reader;
    expect([...new Set(lengths)]).toEqual([original.length]); // 任何时刻都只有原文件长度，无中间态
    expect(readFileSync(p).equals(original)).toBe(true);
  });
});
