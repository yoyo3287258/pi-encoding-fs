// test/grep.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { searchFiles } from "../src/grep";
import { clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "grep-"));
});

describe("searchFiles", () => {
  it("finds ASCII pattern in a UTF-8 file (no config, passthrough)", async () => {
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
    const out = await searchFiles(root, { pattern: "foo" });
    expect(out).toContain("a.txt");
    expect(out).toContain("foo bar");
  });

  it("finds Chinese pattern inside a GB18030 file via nearest config", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    writeFileSync(join(root, "cn.txt"), iconv.encode("第一行\n这里有标记内容\n末行\n", "GB18030"));
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).toContain("cn.txt");
    expect(out).toContain("这里有标记内容");
  });

  it("respects glob include filter", async () => {
    writeFileSync(join(root, "keep.py"), "needle\n", "utf-8");
    writeFileSync(join(root, "skip.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", glob: "*.py" });
    expect(out).toContain("keep.py");
    expect(out).not.toContain("skip.txt");
  });

  it("excludes node_modules and .git by default", async () => {
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, "top.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle" });
    expect(out).toContain("top.txt");
    expect(out).not.toContain(join("node_modules", "x.txt"));
  });

  it("literal mode treats pattern as fixed string", async () => {
    writeFileSync(join(root, "a.txt"), "a.b\naxb\n", "utf-8");
    const out = await searchFiles(root, { pattern: "a.b", literal: true });
    expect(out).toContain("a.b");
    expect(out).not.toContain("axb");
  });
});
