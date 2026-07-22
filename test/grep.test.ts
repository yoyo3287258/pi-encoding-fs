// test/grep.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { searchFiles, buildEncodingGroups, globDirPrefix, findRg } from "../src/grep";
import { clearConfigCache, type FoundConfig } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "grep-"));
});

// ── Pure logic: glob → directory prefix ──────────────────────────────
describe("globDirPrefix", () => {
  it("extracts the directory prefix before the first glob char", () => {
    expect(globDirPrefix("openspec/**")).toBe("openspec");
    expect(globDirPrefix("builder/jinja/templates/**")).toBe("builder/jinja/templates");
    expect(globDirPrefix("docs/**")).toBe("docs");
    expect(globDirPrefix(".claude/**")).toBe(".claude");
    expect(globDirPrefix("legacy/*.c")).toBe("legacy");
  });

  it("returns '.' for bare-filename / root-level patterns", () => {
    expect(globDirPrefix("*.py")).toBe(".");
    expect(globDirPrefix("*.md")).toBe(".");
  });
});

// ── Pure logic: encoding grouping from nearest config ────────────────
describe("buildEncodingGroups", () => {
  it("single default group when no overrides", () => {
    const found: FoundConfig = {
      config: { sourceEncoding: "GB18030", confidenceThreshold: 0.8 },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    expect(groups).toHaveLength(1);
    expect(groups[0].encoding).toBe("GB18030");
    expect(groups[0].includeDirs).toEqual([]); // whole tree
    expect(groups[0].excludeDirs).toEqual([]);
  });

  it("splits default group (excluding override dirs) from override groups", () => {
    const found: FoundConfig = {
      config: {
        sourceEncoding: "GB18030",
        confidenceThreshold: 0.8,
        overrides: [
          { pattern: "openspec/**", sourceEncoding: "UTF-8" },
          { pattern: "docs/**", sourceEncoding: "UTF-8" },
        ],
      },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    const def = groups.find((g) => g.encoding === "GB18030")!;
    const utf = groups.find((g) => g.encoding === "UTF-8")!;
    expect(def).toBeTruthy();
    expect(def.excludeDirs.sort()).toEqual(["docs", "openspec"]);
    expect(def.includeDirs).toEqual([]); // default searches whole tree minus excludes
    expect(utf).toBeTruthy();
    expect(utf.includeDirs.sort()).toEqual(["docs", "openspec"]);
  });

  it("override matching the default encoding does not create a separate group", () => {
    const found: FoundConfig = {
      config: {
        sourceEncoding: "GB18030",
        confidenceThreshold: 0.8,
        overrides: [{ pattern: "gbstuff/**", sourceEncoding: "GB18030" }],
      },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    expect(groups).toHaveLength(1);
    expect(groups[0].encoding).toBe("GB18030");
    expect(groups[0].excludeDirs).toEqual([]);
  });
});

// ── rg availability (environment fact) ───────────────────────────────
describe("findRg", () => {
  it("returns a usable rg path in this environment (rg 15.x installed)", () => {
    const rg = findRg();
    expect(rg).toBeTruthy();
  });
});

// ── searchFiles: real rg-backed search ───────────────────────────────
// These require rg on PATH (verified present). If rg were missing, searchFiles
// returns null (caller falls back to built-in grep).
describe("searchFiles (rg-backed)", () => {
  it("finds ASCII pattern in a UTF-8 file (no config → uses default UTF-8 group)", async () => {
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
    const out = await searchFiles(root, { pattern: "foo" });
    expect(out).not.toBeNull();
    expect(out!).toContain("a.txt");
    expect(out!).toContain("foo bar");
  });

  it("finds Chinese pattern inside a GB18030 file via nearest config", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    writeFileSync(join(root, "cn.txt"), iconv.encode("第一行\n这里有标记内容\n末行\n", "GB18030"));
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).not.toBeNull();
    expect(out!).toContain("cn.txt");
    expect(out!).toContain("这里有标记内容");
  });

  it("searches UTF-8 override dir with utf-8 encoding, GB tree with gb18030", async () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "docs/**", sourceEncoding: "UTF-8" }] }),
    );
    // GB file at root
    writeFileSync(join(root, "gb.txt"), iconv.encode("根目录标记\n", "GB18030"));
    // UTF-8 file under docs
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "u.md"), "文档里的标记\n", "utf-8");
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).not.toBeNull();
    expect(out!).toContain("根目录标记"); // GB group decoded correctly
    expect(out!).toContain("文档里的标记"); // UTF-8 group decoded correctly
  });

  it("respects glob include filter", async () => {
    writeFileSync(join(root, "keep.py"), "needle\n", "utf-8");
    writeFileSync(join(root, "skip.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", glob: "*.py" });
    expect(out).not.toBeNull();
    expect(out!).toContain("keep.py");
    expect(out!).not.toContain("skip.txt");
  });

  it("excludes node_modules and .git by default", async () => {
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, "top.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle" });
    expect(out).not.toBeNull();
    expect(out!).toContain("top.txt");
    expect(out!).not.toContain("x.txt"); // the node_modules file must not be searched
  });

  it("literal mode treats pattern as fixed string", async () => {
    writeFileSync(join(root, "a.txt"), "a.b\naxb\n", "utf-8");
    const out = await searchFiles(root, { pattern: "a.b", literal: true });
    expect(out).not.toBeNull();
    expect(out!).toContain("a.b");
    expect(out!).not.toContain("axb");
  });

  it("ignoreCase matches case-insensitively", async () => {
    writeFileSync(join(root, "a.txt"), "Hello NEEDLE\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", ignoreCase: true });
    expect(out).not.toBeNull();
    expect(out!).toContain("NEEDLE");
  });

  it("context lines are included around a match", async () => {
    writeFileSync(join(root, "a.txt"), "line1\nline2 needle\nline3\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", context: 1 });
    expect(out).not.toBeNull();
    expect(out!).toContain("line1");
    expect(out!).toContain("line2 needle");
    expect(out!).toContain("line3");
  });

  it("returns 'No matches found.' when nothing matches", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n", "utf-8");
    const out = await searchFiles(root, { pattern: "zzz_nope_xyz" });
    expect(out).not.toBeNull();
    expect(out!).toContain("No matches found.");
  });

  it("searches a single file when path points at a file", async () => {
    writeFileSync(join(root, "a.txt"), "needle here\n", "utf-8");
    writeFileSync(join(root, "b.txt"), "nothing\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", path: "a.txt" });
    expect(out).not.toBeNull();
    expect(out!).toContain("needle here");
    expect(out!).not.toContain("b.txt");
  });
});
