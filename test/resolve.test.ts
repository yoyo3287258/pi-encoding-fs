// test/resolve.test.ts — 决策层：读计划 + §3.2 写矩阵（含闸门 3 的拒绝点）
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import {
  resolveReadEncoding,
  resolveWriteEncoding,
  resolveReadPlan,
  resolveWritePlan,
  ruleFor,
} from "../src/resolve";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache, findNearestConfig } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC, JAVA_SRC_UTF8, RARE_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  root = mkdtempSync(join(tmpdir(), "resolve-"));
});

describe("resolveReadEncoding（v1 兼容包装）", () => {
  it("returns null (passthrough) when no config up the tree", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    expect(await resolveReadEncoding(f)).toBeNull();
  });

  // 行为变更（有意，需求文档 §3.1/§6.2 T-15）：上游这里断言「配置说了算」，
  // 而新判定链第 6 步是「字节证据优先于配置」——按 UTF-8 去解 GBK 字节必然产出
  // U+FFFD（读错 + 写回即毁文件），所以改成：字节不是合法 UTF-8 时按判定结果解。
  // 想强制按配置解：给该 pattern 配 "force": true 或 readStrategy:"config"（见下面两个用例）。
  it("config non-GB override no longer overrides byte evidence (was: 'ignores chardet')", async () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "docs/**", sourceEncoding: "UTF-8" }] }),
    );
    mkdirSync(join(root, "docs"));
    const f = join(root, "docs", "x.md");
    writeFileSync(f, iconv.encode("你好", "GB18030")); // 字节是 GBK，配置却说 UTF-8
    expect(await resolveReadEncoding(f)).toBe("GB18030");
    expect((await resolveReadPlan(f))!.transcoded).toBe(true);
  });

  it("force:true 才让配置压倒字节证据", async () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "docs/**", encoding: "UTF-8", force: true }] }),
    );
    mkdirSync(join(root, "docs"));
    const f = join(root, "docs", "x.md");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    const plan = (await resolveReadPlan(f))!;
    expect(plan.verdict.kind).toBe("config");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.note).toContain("force");
  });

  it("config GB: falls back to sourceEncoding for a GB file", async () => {
    putConfig(root, { sourceEncoding: "GB18030" });
    const f = join(root, "a.c");
    writeFileSync(f, iconv.encode("// 中文注释\nint main(){}\n", "GB18030"));
    const enc = await resolveReadEncoding(f);
    expect(enc).toMatch(/GB/i);
  });
});

describe("resolveWriteEncoding（v1 兼容包装）", () => {
  it("returns null (passthrough) when no config", async () => {
    expect(await resolveWriteEncoding(join(root, "new.txt"))).toBeNull();
  });

  it("new file uses nearest-config sourceEncoding without detection", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    expect(await resolveWriteEncoding(join(root, "new.c"))).toBe("GBK");
  });

  it("new file honors override", async () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "utf/**", sourceEncoding: "UTF-8" }] }),
    );
    mkdirSync(join(root, "utf"));
    expect(await resolveWriteEncoding(join(root, "utf", "new.md"))).toBe("UTF-8");
  });
});

describe("§3.2 写矩阵逐行", () => {
  it("行①：文件不存在 → cfg.writeEncoding ?? cfg.sourceEncoding ?? UTF-8", async () => {
    const p = join(root, "sub", "New.java");
    mkdirSync(join(root, "sub"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const plan = await resolveWritePlan(p, "class New{}\n");
    expect(plan.encoding).toBe("GB18030");
    expect(plan.kind).toBe("new");
    expect(plan.reject).toBeNull();
    // 无 writeEncoding 时跟随 sourceEncoding
    putConfig(root, { sourceEncoding: "Big5" });
    expect((await resolveWritePlan(p, "x")).encoding).toBe("Big5");
    // 完全没配置 → 透传
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    expect((await resolveWritePlan(join(bare, "x.txt"), "x")).encoding).toBeNull();
  });

  it("行②：磁盘纯 ASCII → 按项目规范写（这是「GBK 树里新加中文注释」的关键规则）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "A.java");
    writeFileSync(p, Buffer.from("class A{}\r\n", "ascii"));
    const plan = await resolveWritePlan(p, "class A{ /* 中文 */ }\r\n");
    expect(plan.kind).toBe("ascii");
    expect(plan.encoding).toBe("GBK");
    expect(plan.transcoding).toBe(false);
  });

  it("行③：cjk → cfg.writeEncoding；但「读 GBK 写 UTF-8」属于迁移（§7 不做），未 force 一律拒绝", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "UTF-8" });
    const p = join(root, "G.java");
    const gbk = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, gbk);
    const plan = await resolveWritePlan(p, "x");
    // GBK 字节不能在 UTF-8 下无损回环 → 这次写入会把未编辑的部分也改掉 → 闸门 3
    expect(plan.reject).toContain("无损");
    expect(plan.encoding).toBeNull();
    expect(readFileSync(p).equals(gbk)).toBe(true);

    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "UTF-8", overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const forced = await resolveWritePlan(p, "x");
    expect(forced.reject).toBeNull();
    expect(forced.encoding).toBe("UTF-8");

    // 而 GBK → GB18030 是超集方向，逐字节不变 → 正常放行（不触发该闸门）
    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const up = await resolveWritePlan(p, JAVA_SRC);
    expect(up.reject).toBeNull();
    expect(up.encoding).toBe("GB18030");
    expect(up.transcoding).toBe(true); // 名字上发生了转换，但字节不变
  });

  it("行④：utf8/utf8-bom → 强制保持 UTF-8（protectUtf8），只有 force 才放行", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "U.java");
    writeFileSync(p, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const plan = await resolveWritePlan(p, "x");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.transcoding).toBe(false);
    expect(plan.warnings.join(" ")).toContain("UTF-8 文件");
    expect(plan.reject).toBeNull(); // 不是报错，而是「按 UTF-8 原样写」

    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", overrides: [{ pattern: "*", encoding: "GBK", force: true }] });
    const forced = await resolveWritePlan(p, "x");
    expect(forced.encoding).toBe("GBK");
    expect(forced.transcoding).toBe(true);
    expect(forced.warnings.join(" ")).toContain("破坏性语义变更");
  });

  it("force 错配导致的乱码写回必须被拒（U+FFFD 进 GB 系 = 静默变 '?'）", async () => {
    putConfig(root, { overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const p = join(root, "Mojibake.java");
    const utf8Bytes = Buffer.from(JAVA_SRC_UTF8, "utf-8");
    writeFileSync(p, utf8Bytes);
    const rplan = (await resolveReadPlan(p))!;
    expect(rplan.verdict.hasFffd).toBe(true);
    expect(rplan.note).toContain("U+FFFD");
    const dirty = iconv.decode(utf8Bytes, "GBK"); // 按错编码读出的乱码（含 U+FFFD）
    expect(dirty).toContain("\ufffd");
    const plan = await resolveWritePlan(p, dirty);
    expect(plan.reject).toContain("U+FFFD");
    // 干净内容（没碰到 U+FFFD）则允许 force 转换，只给警告
    const clean = await resolveWritePlan(p, "class X{}\n");
    expect(clean.reject).toBeNull();
    expect(clean.encoding).toBe("GBK");
  });

  it("行⑤：utf16 → 保持原 UTF-16 且一定带 BOM", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "U16.ini");
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode("标题\n", "UTF-16LE")]));
    const plan = await resolveWritePlan(p, "标题2\n");
    expect(plan.encoding).toBe("UTF-16LE");
    expect(plan.addBom).toBe("utf16le");
    expect(plan.reject).toBeNull();
  });

  it("行⑥：binary → 任何情况都拒绝", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "b.bin");
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x80, 0xff]));
    const plan = await resolveWritePlan(p, "hello\n");
    expect(plan.reject).toContain("二进制");
    expect(plan.encoding).toBeNull();
    // force 也不能把二进制写出去（binary 守卫在 force 之上）
    putConfig(root, { sourceEncoding: "GBK", overrides: [{ pattern: "*", encoding: "GBK", force: true }] });
    expect((await resolveWritePlan(p, "hello\n")).reject).toContain("二进制");
  });

  it("行⑦：unknown → 拒绝并给出下一步指令（闸门 3）", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "broken.txt");
    writeFileSync(p, Buffer.from("中文中间被截断", "utf-8").subarray(0, 7));
    const plan = await resolveWritePlan(p, "hello\n");
    expect(plan.reject).toContain("UNKNOWN");
    expect(plan.reject).toContain("force");
    expect(plan.encoding).toBeNull();
    // 读侧：透传 + 一行显式警告（§3.1）
    const rplan = (await resolveReadPlan(p))!;
    expect(rplan.note).toContain("[encoding: UNKNOWN");
    expect(rplan.transcoded).toBe(false);
  });

  it("行⑧：无 cfg → 完全透传（encoding=null，行为与未装扩展一致）", async () => {
    const bare = mkdtempSync(join(tmpdir(), "nocfg-"));
    const p = join(bare, "x.txt");
    writeFileSync(p, iconv.encode("你好", "GBK"));
    expect(await ruleFor(p)).toBeNull();
    const plan = await resolveWritePlan(p, "anything");
    expect(plan.encoding).toBeNull();
    expect(plan.reject).toBeNull();
  });
});

describe("BOM 规则（§3.2，修 §2 缺陷 4）", () => {
  it("pi edit 传进来的 content 带前导 U+FEFF 而目标是 GB 系 → 抛错，绝不写 0x3F", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom.java");
    writeFileSync(p, iconv.encode("标题：测试\n", "GBK"));
    const plan = await resolveWritePlan(p, "\ufeff标题：测试2\n");
    expect(plan.reject).toContain("UTF-8 with BOM");
    expect(plan.reject).toContain("0x3F");
  });

  it("目标是 UTF-8 时 BOM 正常编码成 EF BB BF", async () => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "Bom2.txt");
    writeFileSync(p, Buffer.from("x", "ascii"));
    const plan = await resolveWritePlan(p, "\ufeff标题\n");
    expect(plan.reject).toBeNull();
    expect(plan.addBom).toBe("utf8");
  });

  it("UTF-8-BOM 文件在 GB 配置下：保持 UTF-8+BOM（不被 GB 化，BOM 也不丢）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom3.txt");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("标题：测试\n", "utf-8")]);
    writeFileSync(p, original);
    const plan = await resolveWritePlan(p, "\ufeff标题：测试2\n"); // pi 会把 BOM 一起传进来
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.addBom).toBe("utf8");
    expect(plan.reject).toBeNull();
    expect(readFileSync(p).equals(original)).toBe(true); // 计划阶段不写盘
  });
});

describe("扩展：写目标必须能无损回环磁盘字节（UTF-8 保护规则的一般形式）", () => {
  it("GB18030 4 字节内容 + writeEncoding=GBK → 拒绝（未编辑部分会被静默改成 ?）", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GBK" });
    const p = join(root, "Rare.txt");
    writeFileSync(p, iconv.encode(RARE_SRC, "GB18030"));
    const plan = await resolveWritePlan(p, "whatever");
    expect(plan.reject).toContain("无损");
    expect(plan.reject).toContain("GB18030");
  });

  it("同内容 + writeEncoding=GB18030 → 放行（超集，逐字节不变）", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GB18030" });
    const p = join(root, "Rare2.txt");
    writeFileSync(p, iconv.encode(RARE_SRC, "GB18030"));
    const plan = await resolveWritePlan(p, "whatever");
    expect(plan.reject).toBeNull();
    expect(plan.encoding).toBe("GB18030");
  });
});

describe("schema v2 解析（§4）", () => {
  it("confidenceThreshold 仍被解析但不再参与决策", async () => {
    putConfig(root, { sourceEncoding: "GBK", confidenceThreshold: 0.99 });
    const r = await ruleFor(join(root, "x.java"));
    expect(r).not.toBeNull();
    expect((r as unknown as Record<string, unknown>).confidenceThreshold).toBeUndefined(); // 决策上下文里没有它
  });

  it("非法编码名 / 非法 autoCandidates / 坏 JSON 都产生可见 warning，而不是静默失效", async () => {
    putConfig(root, { sourceEncoding: "NOT-A-CODEC", autoCandidates: ["ISO-8859-1"] });
    const p = join(root, "w.txt");
    writeFileSync(p, iconv.encode("你好", "GBK"));
    const r = (await ruleFor(p))!;
    expect(r.warnings.join(" ")).toContain("不可用");
    expect(r.warnings.join(" ")).toContain("P-6");
    clearConfigCache();
    putConfig(root, "{ this is not json }");
    const r2 = (await ruleFor(p))!;
    expect(r2.warnings.join(" ")).toContain("不是合法 JSON");
  });

  it("jsonc 风格（§4 示例里带 // 注释）能解析", async () => {
    putConfig(
      root,
      `{
      // 就近配置：老 Java Web 项目
      "sourceEncoding": "GBK",   /* 读优先候选 */
      "writeEncoding": "GB18030",
      "overrides": [
        { "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true } // 单字节只能 force
      ]
    }`,
    );
    const r = (await ruleFor(join(root, "a.java")))!;
    expect(r.sourceEncoding).toBe("GBK");
    expect(r.writeEncoding).toBe("GB18030");
    expect(r.warnings).toEqual([]);
    const props = join(root, "x.properties");
    writeFileSync(props, Buffer.from("k=abc", "ascii"));
    expect((await ruleFor(props))!.force).toBe(true);
    expect((await ruleFor(props))!.sourceEncoding).toBe("ISO-8859-1");
  });
});

describe("override.encoding 与根 writeEncoding 的优先级（P2 定稿）", () => {
  it("根无迁移意图（write=source）：override 只写 encoding → 新文件/纯 ASCII 按该 override 写", async () => {
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "GBK",
      overrides: [{ pattern: "docs/**", encoding: "UTF-8" }],
    });
    mkdirSync(join(root, "docs"), { recursive: true });
    const fresh = join(root, "docs", "NEW.md");
    expect((await resolveWritePlan(fresh, "# 标题：中文\r\n")).encoding).toBe("UTF-8");
    const ascii = join(root, "docs", "a.md");
    writeFileSync(ascii, "# ascii only\n");
    expect((await resolveWritePlan(ascii, "# ascii only + 中文\n")).encoding).toBe("UTF-8");
    // 同目录里真是 GBK 的文件：保持 GBK（P2.1 定稿：无改写意图时尊重字节判定），只给警告
    const gbkInDocs = join(root, "docs", "legacy.md");
    writeFileSync(gbkInDocs, iconv.encode("# 旧文档 中文\r\n", "GBK"));
    const p = await resolveWritePlan(gbkInDocs, "x");
    expect(p.reject, "保持原编码写回 → 不该再触发闸门 3").toBeNull();
    // 目标 = 判定出的编码。这里不是 GBK 而是 GB18030：本测试没设 autoCandidates/sourceEncoding 偏好，
    // 默认候选链 GB18030 在前且两者都能无损回环（写回字节完全相同）。要 GBK 就把 sourceEncoding 设成 GBK。
    expect(["GBK", "GB18030"]).toContain(p.encoding);
    expect(p.warnings.join("\n")).toContain("不转码");
    // 警告里要点名那条 override，让用户知道怎么改
    const r = await ruleFor(gbkInDocs);
    expect(r!.matchedPattern).toBe("docs/**");
    expect(r!.writeIntent).toBeNull();
    // 真正的不变量：原样写回必须逐字节相等（这才是"不损坏既有编码"）
    const before = readFileSync(gbkInDocs);
    const text = (await makeReadOperations().readFile(gbkInDocs)).toString("utf-8");
    await makeWriteOperations().writeFile(gbkInDocs, text);
    expect(readFileSync(gbkInDocs).equals(before)).toBe(true);
  });

  it("只有显式改写意图（writeEncoding ≠ 读声明）才把已判定文件转写目标编码", async () => {
    // 收紧方向 GBK→GB18030：超集，逐字节不变 → 放行且真的按 GB18030 写
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Up2.java");
    const gbk = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, gbk);
    const plan = await resolveWritePlan(p, JAVA_SRC);
    expect(plan.encoding).toBe("GB18030");
    expect(plan.rule!.writeIntent).toBe("GB18030");
    await makeWriteOperations().writeFile(p, JAVA_SRC);
    expect(readFileSync(p).equals(gbk)).toBe(true); // P-4：逐字节不变
    // ASCII 新文件也按 GB18030（writeEncoding 就是它的目标）
    expect((await resolveWritePlan(join(root, "Fresh2.java"), "class Fresh2{}\r\n")).encoding).toBe("GB18030");
  });

  it("根有迁移意图（write≠source）：根 writeEncoding 赢，并给出可读警告", async () => {
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "UTF-8",
      overrides: [{ pattern: "docs/**", encoding: "GBK" }],
    });
    mkdirSync(join(root, "docs"), { recursive: true });
    const p = join(root, "docs", "n.md");
    const plan = await resolveWritePlan(p, "# 新\r\n");
    expect(plan.encoding).toBe("UTF-8"); // 没被 override 推翻
    expect(plan.warnings.join("\n")).toContain("迁移意图");
    // 显式在 override 里写 writeEncoding 就能反过来锁住
    clearConfigCache();
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "UTF-8",
      overrides: [{ pattern: "docs/**", encoding: "GBK", writeEncoding: "GBK" }],
    });
    expect((await resolveWritePlan(p, "# 新\r\n")).encoding).toBe("GBK");
  });
});

describe("T-15 readStrategy:\"config\" —— 强制按配置解（行为可控，不是崩溃）", () => {
  it("明知是 UTF-8 的文件也被按 GB18030 解；写目标仍由字节判定决定（readStrategy 不影响写侧）", async () => {
    putConfig(root, { sourceEncoding: "GB18030", readStrategy: "config" });
    const p = join(root, "forced.txt");
    writeFileSync(p, "订单服务 =85.5\r\n", "utf-8"); // 磁盘是合法 UTF-8
    const plan = (await resolveReadPlan(p))!;
    expect(plan.verdict.kind).toBe("utf8"); // 字节真相不变（verdict 永远是判定结果）
    expect(plan.kind).toBe("config"); // 但显示层被 readStrategy 压倒
    expect(plan.encoding).toBe("GB18030"); // 被配置压倒 → 显示乱码，但不报错
    expect((await makeReadOperations().readFile(p)).toString("utf-8")).not.toBe("订单服务 =85.5\r\n");
    expect(plan.warnings.join("\n")).toContain("readStrategy");

    const wp = await resolveWritePlan(p, "订单服务 =90.0\r\n");
    expect(wp.reject).toBeNull();
    expect(wp.encoding).toBe("UTF-8"); // 写侧仍按判定：不会被这个配置顺手转成 GB18030
  });

  it("readStrategy 非法值 → 回落 auto 并给出可见 warning（不静默失效）", async () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({ sourceEncoding: "GBK", readStrategy: "magic" }),
    );
    const p = join(root, "x.txt");
    writeFileSync(p, iconv.encode("订单服务\r\n", "GBK"));
    const plan = (await resolveReadPlan(p))!;
    expect(plan.rule.readStrategy).toBe("auto"); // 非法值被纠正
    expect(plan.warnings.join("\n")).toContain("readStrategy"); // 并且让你看到它被纠正了
  });
});

describe("T-14 配置热更新（不手动清缓存也要生效 —— 上游已有，保留）", () => {
  it("改写 .encoding-converter.json 后，下一次解析就用新配置", async () => {
    const p = join(root, "legacy.bin");
    writeFileSync(p, Buffer.from("caf\xe9 na\xefve\r\n", "latin1"));
    putConfig(root, {
      sourceEncoding: "UTF-8",
      overrides: [{ pattern: "*.bin", encoding: "ISO-8859-1", force: true }],
    });
    expect((await resolveReadPlan(p))!.encoding).toBe("ISO-8859-1");

    // 同一会话里用户改了配置（不调用 clearConfigCache）
    putConfig(root, {
      sourceEncoding: "UTF-8",
      overrides: [{ pattern: "*.bin", encoding: "windows-1252", force: true }],
    });
    const again = (await resolveReadPlan(p))!;
    expect(again.encoding).toBe("windows-1252");
    expect(again.verdict.configReason).toBe("force");
  });

  it("mtime 不变但内容变化（size 变了）也能失效；写目标跟着变", async () => {
    const p = join(root, "F.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    expect((await resolveWritePlan(p, JAVA_SRC.replace("85.5", "90.0"))).encoding).toBe("GBK");
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "GBK",
      overrides: [{ pattern: "*.java", encoding: "GBK", writeEncoding: "GB18030" }],
    });
    const wp = await resolveWritePlan(p, JAVA_SRC.replace("85.5", "90.0"));
    expect(wp.encoding).toBe("GB18030"); // override 的显式迁移意图生效
    expect(wp.warnings.length + (wp.reject ? 1 : 0)).toBeGreaterThan(0); // 迁移意图必带可见提示
  });
});
