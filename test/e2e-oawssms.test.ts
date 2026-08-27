// test/e2e-oawssms.test.ts — §8 A-3/A-6/A-7/A-9 的真实工程证据
// 只在能从本机找到目标工程时运行（CI 上自动跳过；用 OAWSSMS_DIR 指向别处也能跑）。
// ⚠️ 绝不写入真实的 SVN 工作副本：先把抽样文件 + 配置复制到临时"影子树"，所有写操作只发生在临时目录里。
import { describe, it, beforeAll, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import iconv from "iconv-lite";
import { classifyBuffer } from "../src/encoding/classify";
import { findNearestConfig, resolveFileRule, clearConfigCache, CONFIG_FILENAME } from "../src/config";
import { resolveWritePlan } from "../src/resolve";
import { makeReadOperations, makeWriteOperations } from "../src/operations";

const PROJ = process.env.OAWSSMS_DIR ?? "D:/temp/OAWSSMS";
const SKIP = !existsSync(join(PROJ, CONFIG_FILENAME));

interface Found {
  rel: string;
  abs: string;
  kind: string;
  /** 内容里已含 U+FFFD / 锟斤拷（前人毁掉的） */
  damaged: boolean;
  size: number;
}

const CLASSIFY_CFG = { sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"] };

/** 分层采样计划：每类够数就停 */
const SAMPLES: { name: string; want: number; pick: (f: Found) => boolean }[] = [
  { name: "ascii-java", want: 40, pick: (f) => f.kind === "ascii" && f.rel.endsWith(".java") },
  { name: "gbk-java", want: 40, pick: (f) => f.kind === "cjk" && f.rel.endsWith(".java") && !f.damaged },
  {
    name: "utf8-java",
    want: 20,
    pick: (f) => (f.kind === "utf8" || f.kind === "utf8-bom") && f.rel.endsWith(".java") && !f.damaged,
  },
  { name: "utf8-jsp", want: 20, pick: (f) => (f.kind === "utf8" || f.kind === "utf8-bom") && f.rel.endsWith(".jsp") },
  { name: "gbk-jsp", want: 12, pick: (f) => f.kind === "cjk" && f.rel.endsWith(".jsp") },
  { name: "properties", want: 10, pick: (f) => f.rel.endsWith(".properties") },
  { name: "damaged", want: 6, pick: (f) => f.damaged },
  { name: "other-text", want: 10, pick: (f) => /\.(xml|html|js|css|sql)$/.test(f.rel) },
];

const isTextish = (name: string) => /\.(java|jsp|properties|xml|html|js|css|sql|vm|txt)$/.test(name);

function collectInto(root: string, chosen: Map<string, Found>, taken: Record<string, number>): number {
  let seen = 0;
  const full = () => SAMPLES.every((s) => (taken[s.name] ?? 0) >= s.want);
  (function walk(dir: string): void {
    if (full()) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (full()) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (![".svn", "target", "node_modules", ".git", ".settings", ".idea"].includes(e.name)) walk(abs);
        continue;
      }
      if (!e.isFile() || !isTextish(e.name)) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.length === 0 || buf.length > 512 * 1024) continue;
      seen++;
      const v = classifyBuffer(buf, CLASSIFY_CFG);
      const rel = relative(root, abs).split(sep).join("/");
      // 「已被前人毁掉」的指纹：解出来含 U+FFFD（UTF-8 侧），或含 锟斤拷（GBK 侧，就是 EF BF BD 被当 GBK 读）
      const text = v.kind === "binary" || v.kind === "unknown" ? "" : iconv.decode(buf, v.encoding);
      const f: Found = {
        rel,
        abs,
        kind: v.kind,
        damaged: text.includes("\ufffd") || text.includes("锟斤拷"),
        size: buf.length,
      };
      for (const s of SAMPLES) {
        if ((taken[s.name] ?? 0) >= s.want) continue;
        if (!s.pick(f)) continue;
        taken[s.name] = (taken[s.name] ?? 0) + 1;
        chosen.set(rel, f);
        break;
      }
    }
  })(root);
  return seen;
}

describe.skipIf(SKIP)(`真实工程影子树端到端（${PROJ}）`, () => {
  let shadow = "";
  const chosen = new Map<string, Found>();
  const taken: Record<string, number> = {};

  beforeAll(() => {
    shadow = mkdtempSync(join(tmpdir(), "oawssms-shadow-"));
    const seen = collectInto(PROJ, chosen, taken);
    for (const f of chosen.values()) {
      const dst = join(shadow, f.rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(f.abs, dst);
    }
    copyFileSync(join(PROJ, CONFIG_FILENAME), join(shadow, CONFIG_FILENAME));
    clearConfigCache();
    console.log(
      `采样：扫了 ${seen} 个文本文件 → 影子树 ${chosen.size} 个（${Object.entries(taken).map(([k, v]) => `${k}:${v}`).join(" ")}）`,
    );
  }, 300_000);

  it("A-9 配置解析：无 warning、无 schema 错误", async () => {
    const found = await findNearestConfig(shadow);
    expect(found, "没找到配置文件").not.toBeNull();
    expect(found!.warnings ?? []).toEqual([]);
    const rule = resolveFileRule(join(shadow, "Probe.java"), found!);
    expect(rule.sourceEncoding).toBe("GBK");
    expect(rule.writeEncoding).toBe("GBK");
    expect(found!.config.overrides).toHaveLength(4);
  });

  it("A-3 读→写幂等：内容不动时逐字节相等（CRLF 保持、0 字节差异）", async () => {
    const rd = makeReadOperations();
    const wr = makeWriteOperations();
    const failures: string[] = [];
    for (const f of chosen.values()) {
      const p = join(shadow, f.rel);
      const text = (await rd.readFile(p)).toString("utf-8");
      await wr.writeFile(p, text);
      const after = readFileSync(p);
      if (Buffer.compare(readFileSync(f.abs), after) !== 0) {
        failures.push(`${f.rel}（判定 ${f.kind}，${after.length - f.size}B）`);
      }
    }
    console.log(`读→写幂等：${chosen.size} 个真实文件，不一致 ${failures.length} 个${failures.length ? " → " + failures.slice(0, 5).join(", ") : ""}`);
    expect(failures).toEqual([]);
  }, 300_000);

  it("A-6 前人被毁掉的文件：要么无损写回、要么响亮拒绝，绝不静默变 '?'", async () => {
    const damaged = [...chosen.values()].filter((f) => f.damaged);
    expect(damaged.length, "没采到受损文件").toBeGreaterThan(0);
    const rd = makeReadOperations();
    const wr = makeWriteOperations();
    const lossless: string[] = [];
    const refused: string[] = [];
    const bad: string[] = [];
    for (const f of damaged) {
      const p = join(shadow, f.rel);
      const original = readFileSync(f.abs);
      const text = (await rd.readFile(p)).toString("utf-8");
      let msg = "";
      try {
        await wr.writeFile(p, text);
      } catch (e) {
        msg = (e as Error).message;
      }
      if (msg) {
        if (!/闸门/.test(msg)) bad.push(`${f.rel}: 报的不是闸门错 → ${msg.slice(0, 80)}`);
        else if (!readFileSync(p).equals(original)) bad.push(`${f.rel}: 拒写却没保持磁盘原样`);
        else refused.push(f.rel);
      } else {
        const after = readFileSync(p);
        if (!after.equals(original)) bad.push(`${f.rel}: 写回改变了字节`);
        else if (original.includes(0x3f) && !after.includes(0x3f)) bad.push(`${f.rel}: '?' 数发生变化`);
        else lossless.push(f.rel);
      }
    }
    console.log(`受损文件 ${damaged.length} 个：无损写回 ${lossless.length}，闸门拒写 ${refused.length}，违规 ${bad.length}${bad.length ? " → " + bad.join(" | ") : ""}`);
    expect(bad).toEqual([]);
  }, 300_000);

  it("UTF-8 保护：同目录混住的 UTF-8 java/jsp 一律按 UTF-8 写，不降级成 GBK", async () => {
    const utf8 = [...chosen.values()].filter(
      (f) => (f.kind === "utf8" || f.kind === "utf8-bom") && /\.java$|\.jsp$/.test(f.rel) && f.size > 200,
    );
    expect(utf8.length).toBeGreaterThan(5);
    let bom = 0;
    for (const f of utf8) {
      const plan = await resolveWritePlan(join(shadow, f.rel), "x");
      expect(plan.encoding, f.rel).toBe("UTF-8");
      if (f.kind === "utf8-bom") {
        expect(plan.addBom, f.rel).toBe("utf8");
        bom++;
      }
    }
    console.log(`UTF-8 保护：${utf8.length} 个（其中 ${bom} 个 BOM 需还原）`);
  });

  it("GBK java 的目标编码恒为 GBK；Big5/EUC-KR 误判为 0", async () => {
    const gbk = [...chosen.values()].filter((f) => f.kind === "cjk" && f.rel.endsWith(".java") && !f.damaged);
    expect(gbk.length).toBeGreaterThan(20);
    const wrong: string[] = [];
    for (const f of gbk) {
      const plan = await resolveWritePlan(join(shadow, f.rel), "x");
      if (plan.encoding !== "GBK") wrong.push(`${f.rel}→${plan.encoding}`);
    }
    console.log(`GBK java：${gbk.length} 个，目标非 GBK 的 ${wrong.length} 个${wrong.length ? " → " + wrong.slice(0, 5).join(", ") : ""}`);
    expect(wrong).toEqual([]);
  });

  it("properties 走 ISO-8859-1 + force + escape：写中文变 \\uXXXX（native2ascii 约定）", async () => {
    // 只挑没被目录型 override 盖到的（具体度：conf/tplt/** 高于 *.properties）
    const props = [...chosen.values()].filter((f) => f.rel.endsWith(".properties") && !f.rel.startsWith("conf/"));
    expect(props.length, "采样里没找到 .properties").toBeGreaterThan(0);
    const p = join(shadow, props[0].rel);
    const before = readFileSync(p);
    await makeWriteOperations().writeFile(p, before.toString("latin1") + "key.cn=中文配置\r\n");
    const s = readFileSync(p).toString("latin1");
    expect(s, props[0].rel).toContain("\\u4e2d\\u6587");
    expect(readFileSync(p).includes(0x3f)).toBe(false); // 没有 '?'
    expect(s.startsWith(before.toString("latin1"))).toBe(true); // 原 ASCII 内容逐字节不变
  });

  it("目录 override 决定新建/纯 ASCII 文件的写目标（UTF-8 目录不会冒出 GBK 新文件）", async () => {
    const probe = join(shadow, "WebContent", "MobileSSOA", "New.js");
    mkdirSync(dirname(probe), { recursive: true });
    const plan = await resolveWritePlan(probe, "// 新文件注释\r\n");
    expect(plan.encoding).toBe("UTF-8");
    const plain = join(shadow, "src", "PlainNew.java");
    mkdirSync(dirname(plain), { recursive: true });
    expect((await resolveWritePlan(plain, "// 中文\r\n")).encoding).toBe("GBK");
  });

  it("A-7 延迟：真实 java 的首次 read 附加延迟（闸门全开）+ 写耗时", async () => {
    const files = [...chosen.values()].filter((f) => f.rel.endsWith(".java") && !f.damaged).slice(0, 200);
    expect(files.length).toBeGreaterThan(50);
    const rd = makeReadOperations();
    // 基准：没有本扩展时 pi 本来就要做的 readFile + toString
    let base = 0;
    for (const f of files) {
      const p = join(shadow, f.rel);
      const t = process.hrtime.bigint();
      void (await readFileSync(p).toString("utf-8"));
      base += Number(process.hrtime.bigint() - t);
    }
    clearConfigCache();
    let first = 0; // 首次（无判定缓存）
    const texts = new Map<string, string>();
    for (const f of files) {
      const p = join(shadow, f.rel);
      const t = process.hrtime.bigint();
      texts.set(p, (await rd.readFile(p)).toString("utf-8"));
      first += Number(process.hrtime.bigint() - t);
    }
    let cached = 0; // 第二次（走 mtime 缓存）
    for (const f of files) {
      const p = join(shadow, f.rel);
      const t = process.hrtime.bigint();
      void (await rd.readFile(p)).toString("utf-8");
      cached += Number(process.hrtime.bigint() - t);
    }
    const n = files.length;
    const avgKb = files.reduce((a, f) => a + f.size, 0) / 1024 / n;
    const w0 = Date.now();
    for (const f of files) {
      const p = join(shadow, f.rel);
      await makeWriteOperations().writeFile(p, texts.get(p)!);
    }
    const wMs = (Date.now() - w0) / n;
    console.log(
      `${n} 个真实 java（平均 ${avgKb.toFixed(1)}KB）：首次 read 附加 ${(first / n / 1e6).toFixed(2)}ms（基准 ${(base / n / 1e6).toFixed(2)}ms）` +
        `｜缓存后 read ${Math.max(0, (cached - first) / n / 1e6).toFixed(2)}ms｜三道闸门全开 write ${wMs.toFixed(2)}ms`,
    );
    expect(first / n / 1e6 - base / n / 1e6).toBeLessThan(5); // §8 A-7
  }, 300_000);

  it("行尾分布复核：真实 GBK java 以 CRLF 为主（写回必须保持）", () => {
    let crlf = 0,
      lf = 0,
      mixed = 0;
    for (const f of chosen.values()) {
      if (!f.rel.endsWith(".java") || f.kind !== "cjk" || f.damaged) continue;
      const b = readFileSync(f.abs);
      const hasCrlf = b.includes(Buffer.from("\r\n"));
      const loneLf = [...b].some((x, i) => x === 0x0a && (i === 0 || b[i - 1] !== 0x0d));
      if (hasCrlf && loneLf) mixed++;
      else if (hasCrlf) crlf++;
      else if (loneLf) lf++;
    }
    console.log(`采样内 GBK java 行尾：CRLF ${crlf} / LF ${lf} / 混用 ${mixed}`);
    expect(crlf + lf + mixed).toBeGreaterThan(20);
  });
});
