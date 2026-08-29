// test/grep.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { searchFiles, buildEncodingGroups, buildEncodingPasses, globDirPrefix, findRg } from "../src/grep";
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

// ── searchFiles：P3 语义 ─────────────────────────────────────────────
// 有配置 → 走自实现（多趟编码 + 逐文件判定过滤）；无配置 → 返回 null，由调用方整体委托内置。
const cfg = (o: Record<string, unknown> = { sourceEncoding: "UTF-8" }) =>
  writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify(o));

describe("searchFiles（自实现路径）", () => {
  it("finds ASCII pattern in a UTF-8 file", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
    const out = await searchFiles(root, { pattern: "foo" });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("a.txt");
    expect(out!.text).toContain("foo bar");
  });

  it("T-10 GB18030 目录搜中文命中（内置 grep 在此必然搜不到）", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(join(root, "cn.txt"), iconv.encode("第一行\n这里有标记内容\n末行\n", "GB18030"));
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("cn.txt");
    expect(out!.text).toContain("这里有标记内容");
    expect(out!.searchedWith.length).toBeGreaterThan(1); // 确实跑了 GB 那一趟
  });

  it("T-10 --hidden 补齐：配置树里的点文件仍可搜到", async () => {
    cfg();
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".env"), "SECRET_TOKEN=abc\n", "utf-8");
    writeFileSync(join(root, ".github", "w.yml"), "SECRET_TOKEN: xyz\n", "utf-8");
    const out = await searchFiles(root, { pattern: "SECRET_TOKEN" });
    expect(out!.text).toContain(".env");
    expect(out!.text).toContain(".github/w.yml");
  });

  it("同目录混住 UTF-8 + GBK：两侧都命中且不重复计数", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(join(root, "gb.txt"), iconv.encode("根目录标记\n", "GB18030"));
    writeFileSync(join(root, "u8.txt"), "文档里的标记\n", "utf-8");
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out!.text).toContain("根目录标记");
    expect(out!.text).toContain("文档里的标记");
    const hits = out!.text.split("\n").filter((l) => l.includes("标记"));
    expect(hits).toHaveLength(2); // 每个文件恰好一次（多趟之间用 file:line 去重）
  });

  it("误命中防护：UTF-8 文件的字节被 GBK 趟解成乱码关键词时不得计入", async () => {
    cfg({ sourceEncoding: "GB18030" });
    const real = "中文报警";
    const utf8Bytes = Buffer.from(real, "utf-8");
    const mojibake = iconv.decode(utf8Bytes, "GBK"); // "涓枃鎶ヨ" —— 用这个词去搜
    writeFileSync(join(root, "u8.txt"), utf8Bytes); // 磁盘上是合法 UTF-8
    const out = await searchFiles(root, { pattern: mojibake });
    // GBK 趟的 rg 会按 GBK 码位编出同样的字节 → 裸 rg 必然命中；判定过滤器必须丢掉它
    expect(out!.text).toBe("No matches found");
  });

  it("respects glob include filter", async () => {
    cfg();
    writeFileSync(join(root, "keep.py"), "needle\n", "utf-8");
    writeFileSync(join(root, "skip.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", glob: "*.py" });
    expect(out!.text).toContain("keep.py");
    expect(out!.text).not.toContain("skip.txt");
  });

  it("excludes node_modules / .git / .svn by default", async () => {
    cfg();
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".svn"));
    writeFileSync(join(root, "node_modules", "x.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, ".svn", "pristine.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, "top.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle" });
    expect(out!.text).toContain("top.txt");
    expect(out!.text).not.toContain("x.txt");
    expect(out!.text).not.toContain("pristine");
  });

  it("literal mode treats pattern as fixed string", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "a.b\naxb\n", "utf-8");
    const out = await searchFiles(root, { pattern: "a.b", literal: true });
    expect(out!.text).toContain("a.b");
    expect(out!.text).not.toContain("axb");
  });

  it("ignoreCase matches case-insensitively", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "Hello NEEDLE\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", ignoreCase: true });
    expect(out!.text).toContain("NEEDLE");
  });

  it("context lines are decoded with the same chain as read (GBK 上下文不乱码)", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(
      join(root, "a.txt"),
      iconv.encode("第一行 中文\n第二行 needle\n第三行 中文\n", "GB18030"),
    );
    const out = await searchFiles(root, { pattern: "needle", context: 1 });
    expect(out!.text).toContain("第一行 中文");
    expect(out!.text).toContain("第二行 needle");
    expect(out!.text).toContain("第三行 中文");
    expect(out!.text).toContain("a.txt-1- 第一行 中文"); // 上下文行格式 path-行号- 与内置一致
  });

  it("returns 'No matches found' (内置文案，无句号)", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "hello\n", "utf-8");
    const out = await searchFiles(root, { pattern: "zzz_nope_xyz" });
    expect(out!.text).toBe("No matches found");
  });

  it("searches a single file when path points at a file", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "needle here\n", "utf-8");
    writeFileSync(join(root, "b.txt"), "nothing\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", path: "a.txt" });
    expect(out!.text).toContain("needle here");
    expect(out!.text).not.toContain("b.txt");
  });

  it("limit 语义与内置一致：同一条 limit=1 提示语一模一样", async () => {
    cfg();
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "needle\n", "utf-8");
    const mine = await searchFiles(root, { pattern: "needle", limit: 1 });
    expect(mine!.details.matchLimitReached).toBe(1);
    expect(mine!.text).toContain("1 matches limit reached. Use limit=2 for more, or refine pattern");
  });
});

describe("T-8/T-10 与内置 grep 的行为一致性", () => {
  it("无配置目录 → searchFiles 返回 null（调用方整体委托内置）", async () => {
    writeFileSync(join(root, "a.txt"), "needle\n", "utf-8");
    expect(await searchFiles(root, { pattern: "needle" })).toBeNull();
  });

  it("无配置目录：本扩展 grep 与内置 grep 命中集合一致", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, ".hidden.txt"), "needle hidden\n", "utf-8");
    writeFileSync(join(root, "sub", "b.txt"), "中文 needle\n", "utf-8");
    const { createGrepToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const { createEncodingGrepDefinition } = await import("../src/grep");
    type Def = { execute: (...a: unknown[]) => Promise<{ content: [{ text?: string }] }> };
    const call = async (def: Def) => {
      const r = await def.execute("tc", { pattern: "needle" }, undefined, () => {}, {} as never);
      return (r.content[0] as { text: string }).text;
    };
    const asDef = (d: unknown) => d as Def;
    const builtin = asDef(createGrepToolDefinition(root));
    const mine = asDef(createEncodingGrepDefinition(root));
    const a = (await call(mine)).split("\n").sort();
    const b = (await call(builtin)).split("\n").sort();
    // 命中内容必须一致。顺序上本扩展额外做了确定性排序（内置按 rg 遍历序，
    // 实测同一目录连跑三次顺序可能不同），所以比的是排序后的集合。
    expect(a).toEqual(b);
    expect(a.join("\n")).toContain(".hidden.txt:1: needle hidden");
    expect(a.join("\n")).toContain("sub/b.txt:1: 中文 needle");
  });

  it("findRg 命中 pi 自带的 ~/.pi/agent/bin/rg（本机存在时）", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const p = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
    if (!fs.existsSync(p)) return; // 这台机器没装 pi 的 rg，跳过（不断言失败）
    const { resetRgCache } = await import("../src/grep");
    resetRgCache();
    expect(findRg()).toBe(p);
  });
});

describe("buildEncodingPasses（P3 新增）", () => {
  const found = (config: unknown): FoundConfig => ({ config: config as never, configDir: root, warnings: [] });

  it("纯 ASCII pattern 只跑 UTF-8 一趟", () => {
    expect(buildEncodingPasses(found({ sourceEncoding: "GB18030", autoCandidates: ["GB18030"] }), "needle")).toEqual([
      "UTF-8",
    ]);
  });
  it("中文 pattern + GB 家族折叠成 GB18030 一趟", () => {
    const p = buildEncodingPasses(
      found({ sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"] }),
      "标记",
    );
    expect(p).toEqual(["UTF-8", "BIG5", "GB18030"]);
  });
  it("单字节编码不进趟（装不下中文，ASCII 部分已由 UTF-8 趟覆盖）", () => {
    expect(
      buildEncodingPasses(
        found({ sourceEncoding: "UTF-8", overrides: [{ pattern: "*.properties", encoding: "ISO-8859-1" }] }),
        "标记",
      ),
    ).toEqual(["UTF-8"]);
  });
  it("override 声明的 Big5 会进集合", () => {
    const p = buildEncodingPasses(
      found({ sourceEncoding: "UTF-8", overrides: [{ pattern: "tw/**", encoding: "Big5" }] }),
      "標記",
    );
    expect(p).toContain("BIG5");
  });
  it("无配置 → 只有 UTF-8", () => {
    expect(buildEncodingPasses(null, "标记")).toEqual(["UTF-8"]);
  });
});
