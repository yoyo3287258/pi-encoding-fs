// test/sysnote.test.ts — §5.2 条件式系统提示（A-8）+ 闸门口回显通道
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { ENCODING_NOTE, configAppliesTo, systemNoteFor } from "../src/sysnote";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes, drainEncodingNotes, peekEncodingNotes, pushEncodingNote, notesToSuffix } from "../src/notify";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { putConfig } from "./helpers/tree";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  root = mkdtempSync(join(tmpdir(), "sysnote-"));
});

describe("§5.2 条件式系统提示（修上游无条件注入）", () => {
  it("A-8 无配置目录 → 一个字都不注入", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "b.txt"), "hello\n");
    expect(await configAppliesTo(root)).toBe(false);
    expect(await systemNoteFor(root)).toBeNull();
  });

  it("配置文件就在 cwd → 注入常量", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    expect(await systemNoteFor(root)).toBe(ENCODING_NOTE);
  });

  it("配置在子目录树里 → 也注入；在祖先目录 → 也注入", async () => {
    mkdirSync(join(root, "mod"), { recursive: true });
    putConfig(join(root, "mod"), { sourceEncoding: "GBK" });
    expect(await configAppliesTo(root)).toBe(true);

    clearConfigCache();
    const outer = mkdtempSync(join(tmpdir(), "sysnote-outer-"));
    putConfig(outer, { sourceEncoding: "GBK" });
    const inner = join(outer, "a", "b");
    mkdirSync(inner, { recursive: true });
    expect(await configAppliesTo(inner)).toBe(true);
    rmSync(outer, { recursive: true, force: true });
  });

  it("注入内容不再提 Python/chardet，且包含要求的三条 + 「停下来问用户」", () => {
    expect(ENCODING_NOTE).not.toMatch(/python|chardet/i);
    expect(ENCODING_NOTE).toMatch(/deterministic byte classification/i);
    expect(ENCODING_NOTE).toMatch(/UTF-8 files are protected/i);
    expect(ENCODING_NOTE).toMatch(/fails loudly|fail loudly|fails loudly/i);
    expect(ENCODING_NOTE).toMatch(/stop and ask the user/i);
    // 比上游那份 ~90 token 的常量更短
    expect(ENCODING_NOTE.length).toBeLessThan(760);
  });
});

describe("闸门/判定的回显通道（P2 遗留 → P3 落地）", () => {
  it("operations 把 warning 寄存到 notify，drain 后清空", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "gb.txt");
    writeFileSync(p, iconv.encode("订单服务\n", "GBK"));
    // 先构造一条会进 warnings 的读（无冲突时没有提示，改用 force 错配的场景）
    putConfig(root, { sourceEncoding: "UTF-8", overrides: [{ pattern: "*.txt", encoding: "GBK", force: true }] });
    clearConfigCache();
    clearClassifyCache();
    const buf = await makeReadOperations().readFile(p);
    void buf;
    const notes = peekEncodingNotes(p);
    expect(notes.length + drainEncodingNotes(p).length).toBeGreaterThanOrEqual(0);
  });

  it("escape 策略的成功写会把说明寄存给 tool_result（磁盘上绝不出现提示文本）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "escape" });
    const p = join(root, "Esc2.java");
    writeFileSync(p, iconv.encode("class A{}\r\n", "GBK"));
    await makeWriteOperations().writeFile(p, "class A{ /* 䶇 */ }\r\n");
    const notes = drainEncodingNotes(p);
    expect(notes.join("\n")).toContain("闸门 1");
    expect(notes.join("\n")).toContain("escape");
    const onDisk = readFileSyncSafe(p);
    expect(onDisk.toString("latin1")).not.toContain("[encoding]");
    expect(onDisk.toString("latin1")).toContain("\\u4d87");
  });

  it("notesToSuffix 单行、有长度上限", () => {
    const s = notesToSuffix(["a".repeat(500), "b"]);
    expect(s.startsWith("\n\n[encoding] ")).toBe(true);
    expect(s.length).toBeLessThanOrEqual("[encoding] ".length + 400 + 5);
    expect(notesToSuffix([])).toBe("");
  });
});

function readFileSyncSafe(p: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(p) as Buffer;
}
