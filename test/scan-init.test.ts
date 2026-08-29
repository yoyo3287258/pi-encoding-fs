/**
 * tools/scan-encoding.mjs 的 --init 回归测试。
 *
 * 存在的理由：文档（CONFIG-GUIDE 三步上手 / INSTALL）承诺过 `--init`，而脚本里
 * 当时**根本没有这个参数**，会被静默忽略 → 用户以为生成了配置其实没有。
 * 这类"文档 ↔ 工具漂移"只能靠真跑子进程钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iconv from "iconv-lite";
import { stripJsonComments, findNearestConfigSync, resolveFileRule } from "../src/config";
import { resolveReadPlan } from "../src/resolve";

const TOOL = path.join(process.cwd(), "tools", "scan-encoding.mjs");
let root = "";

beforeAll(() => {
  root = mkdtemp("scan-init-");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkdtemp(prefix: string): string {
  const p = path.join(os.tmpdir(), prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
  mkdirSync(p, { recursive: true });
  return p;
}
function w(rel: string, content: string | Buffer, base = root) {
  const abs = path.join(base, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
function gbk(text: string): Buffer {
  return iconv.encode(text, "GBK");
}
/** 跑 --init；返回 { stdout, code, cfgPath } */
function init(dir: string, extra: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, dir, "--init", ...extra], { encoding: "utf-8", maxBuffer: 64 << 20 });
    return { stdout, code: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout || "") + String(e.stderr || ""), code: typeof e.status === "number" ? e.status : -1 };
  }
}
/** 跑任意参数组合（用来验参数校验与 --damaged 这类聚焦输出） */
function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf-8", maxBuffer: 64 << 20 });
    return { stdout, code: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout || "") + String(e.stderr || ""), code: typeof e.status === "number" ? e.status : -1 };
  }
}
function readCfg(dir: string) {
  const f = path.join(dir, ".encoding-converter.json");
  expect(existsSync(f)).toBe(true);
  return JSON.parse(stripJsonComments(readFileSync(f, "utf-8")));
}

describe("scan-encoding --init", () => {
  it("① 全歧义的 GBK 树 → 取「能覆盖全部字节的最窄编码」GBK，而不是超集 GB18030", () => {
    const d = mkdtemp("narrow-");
    for (let n = 0; n < 6; n++) w(`src/F${n}.java`, gbk(`/** 订单服务第${n}个，报警阈值=85.5 。*/ class F${n}{}`), d);
    const r = init(d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已写出");
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK");
    expect(cfg.writeEncoding).toBe("GBK");
    // 依据必须印在头部注释里：这份配置是要进仓库的，别人得能看懂为什么是 GBK
    const head = readFileSync(path.join(d, ".encoding-converter.json"), "utf-8");
    expect(head).toContain("最窄");
    expect(head).toContain("sourceEncoding = GBK");
  });

  it("② 有一个文件需要 GB18030 扩展区 → 整体退到 GB18030（窄编码覆盖不了就不假装能）", () => {
    const d = mkdtemp("wide-");
    for (let n = 0; n < 5; n++) w(`src/G${n}.java`, gbk(`/** 普通中文${n} */ class G${n}{}`), d);
    w("src/Ext.java", iconv.encode("/** 扩展区汉字 \uD840\uDC0B 尾 */ class Ext{}", "GB18030"), d);
    expect(init(d).code).toBe(0);
    expect(readCfg(d).sourceEncoding).toBe("GB18030");
  });

  it("③ 工程声明优先于字节推断（pom 说 UTF-8 就用 UTF-8），但已判定为 GBK 的文件仍按自身编码读", async () => {
    const d = mkdtemp("decl-");
    w("pom.xml", "<project><properties><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>\n", d);
    const java = w(`src/A.java`, gbk("/** 中文注释 。*/ class A{}"), d);
    const r = init(d);
    expect(r.stdout).toContain("工程声明");
    expect(readCfg(d).sourceEncoding).toBe("UTF-8");
    // 关键：配置根编码是 UTF-8，不代表会把 GBK 文件当 UTF-8 读 —— 读链路仍由字节决定
    const found = findNearestConfigSync(d);
    expect(found).toBeTruthy();
    const plan = await resolveReadPlan(java); // resolveReadPlan(absPath) 是 async，自己会找配置
    expect(plan).not.toBeNull();
    expect(plan!.transcoded).toBe(true);
    // 注意：根声明是 UTF-8 时，GBK 字节属于“多候选歧义”，按 autoCandidates 顺序取 GB18030
    // （性质 P-3；根编码若写 GBK 则 GBK 胜）。关键是：仍按字节事实转码，不把 GBK 当 UTF-8 读。
    expect(/^GB(18030|K)$/.test(plan!.encoding)).toBe(true);
    expect(plan!.kind).toBe("cjk");
    void resolveFileRule;
  });

  it("④ Eclipse 逐路径声明被搬成 override；与字节事实不符的声明不采纳", () => {
    const d = mkdtemp("eclipse-");
    w(
      ".settings/org.eclipse.core.resources.prefs",
      [
        "eclipse.preferences.version=1",
        "encoding//modern/js/a=UTF-8",
        // 这条声明说 legacy 是 GBK，但下面那个文件字节上是 UTF-8 → 不该被采纳
        "encoding//wrong/x.js=GBK",
      ].join("\n") + "\n",
      d,
    );
    for (let n = 0; n < 6; n++) w(`modern/js/a/F${n}.js`, `var v=${n}; // 中文注释\r\n`, d); // 真 UTF-8 字节：与声明一致
    for (let n = 0; n < 4; n++) w(`src/S${n}.java`, gbk(`/** 服务${n} 。*/ class S${n}{}`), d);
    w("wrong/x.js", Buffer.from("var ok = 1; // 中文注释\n", "utf-8"), d); // 字节是 UTF-8，声明却说是 GBK → 不采纳
    const r = init(d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("没采纳声明 wrong/x.js");
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK"); // 根编码由 src/*.java 推出来
    const pats = cfg.overrides.map((o: any) => o.pattern);
    expect(pats).toContain("modern/js/a/**");
    expect(pats.find((p: string) => p.includes("wrong"))).toBeUndefined();
  });

  it("⑤ 已有配置时拒绝覆盖（退出码非 0、内容未变）；--force 才覆盖；--dry-run 不碰磁盘", () => {
    const d = mkdtemp("force-");
    for (let n = 0; n < 4; n++) w(`src/T${n}.java`, gbk(`/** 中文${n} 。*/ class T${n}{}`), d);
    expect(init(d).code).toBe(0);
    const mine = '{ "sourceEncoding": "Big5", "writeEncoding": "Big5" }\n';
    const cfgPath = path.join(d, ".encoding-converter.json");
    writeFileSync(cfgPath, mine, "utf-8");

    const again = init(d);
    expect(again.code).not.toBe(0);
    expect(again.stdout).toContain("未改动");
    expect(readFileSync(cfgPath, "utf-8")).toBe(mine); // 用户手写的内容一个字节都没被动过

    const dry = init(d, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("磁盘未动");
    expect(readFileSync(cfgPath, "utf-8")).toBe(mine);

    expect(init(d, ["--force"]).code).toBe(0);
    expect(readFileSync(cfgPath, "utf-8")).not.toBe(mine);
    expect(readCfg(d).sourceEncoding).toBe("GBK");
  });

  it("⑥ 纯 UTF-8 项目 → 写 UTF-8 配置（而不是硬塞一个 GB 系编码）", () => {
    const d = mkdtemp("utf8only-");
    for (let n = 0; n < 5; n++) w(`src/U${n}.java`, `/** 中文注释${n} 。*/ class U${n}{}`, d);
    expect(init(d).code).toBe(0);
    expect(readCfg(d).sourceEncoding).toBe("UTF-8");
  });

  it("⑦ 生成的配置能被扩展自己解析，且不留警告（schema v2 完整性）", () => {
    const d = mkdtemp("parse-");
    for (let n = 0; n < 4; n++) w(`src/V${n}.java`, gbk(`/** 中文${n} 。*/ class V${n}{}`), d);
    w("src/Prop.properties", gbk("k=中文值\r\n"), d);
    expect(init(d).code).toBe(0);
    const abs = findNearestConfigSync(d)!;
    const rule = resolveFileRule(path.join(d, "src/V0.java"), abs);
    expect(rule.warnings.length).toBe(0); // 生成的键全部合法，不该产生任何"我忽略了某个键"的警告
    expect(rule.unmappable).toBe("error");
    expect(rule.verifyWrite).toBe(true);
    expect(rule.protectUtf8).toBe(true);
  });

  it("⑧ 目录多数推断：根编码是 GBK 时，把「目录内非 ASCII 多数是 UTF-8（≥70% 且 ≥8 个）」的目录补成 UTF-8 override，只取最浅层", () => {
    const d = mkdtemp("dirmajor-");
    // 根：传统 GBK 文件（把根编码推成 GBK）
    for (let n = 0; n < 6; n++) w(`src/S${n}.java`, gbk(`/** 服务${n} 。*/ class S${n}{}`), d);
    // WebContent/ 下：大量 UTF-8 jsp + 少量 GBK 遗留（旧实现因“0 个传统文件”而发不出 override）
    for (let n = 0; n < 10; n++) w(`WebContent/page/p${n}.jsp`, `<%-- 订单页面${n}：报警阈值=85.5 --%>`, d);
    for (let n = 0; n < 2; n++) w(`WebContent/page/legacy${n}.jsp`, gbk(`<%-- 旧页面${n}：遗留编码 --%>`), d);
    const r = init(d);
    expect(r.code).toBe(0);
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK");
    const pats = cfg.overrides.map((o: any) => o.pattern);
    // 必须生成最浅层 WebContent/** → UTF-8，而不是 WebContent/page/** 或更深
    expect(pats).toContain("WebContent/**");
    expect(pats).not.toContain("WebContent/page/**");
    // 依据打印在 stdout 的 notes 里，让别人看得懂为什么是 UTF-8
    expect(r.stdout).toContain("WebContent/** → UTF-8");
    expect(r.stdout).toContain("占");
  });

  it("⑨ 参数校验：漏了 -- 或乱写开关必须退出码 2 并提示，不能静默跑成普通画像", () => {
    const d = mkdtemp("args-");
    for (let n = 0; n < 3; n++) w(`src/W${n}.java`, gbk(`/** 中文${n} 。*/ class W${n}{}`), d);
    // 真实踩过的坑：`. init` 被当成普通画像跑完，用户以为生成了配置
    const typo = run([d, "init"]);
    expect(typo.code).toBe(2);
    expect(typo.stdout).toContain("缺少前缀");
    expect(typo.stdout).toContain("--init");
    expect(existsSync(path.join(d, ".encoding-converter.json"))).toBe(false);
    // 未知开关也要拦住，并给就近建议
    const bogus = run([d, "--int"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stdout).toContain("未知参数");
    // 正确写法仍然正常工作（校验没把合法参数块掉）
    expect(run([d, "--init", "--out", path.join(d, "r.csv")]).code).toBe(0);
  });

  it("⑩ --damaged 真实存在（文档承诺过），且不会把扩展自己的配置文件算成受损", () => {
    const d = mkdtemp("damaged-");
    for (let n = 0; n < 3; n++) w(`src/X${n}.java`, gbk(`/** 中文${n} 。*/ class X${n}{}`), d);
    // 一个真受损文件：内容里带 U+FFFD
    w("src/Broken.java", Buffer.from("/** 已被毁掉的注释 \uFFFD\uFFFD */ class Broken{}", "utf-8"), d);
    expect(init(d).code).toBe(0); // 生成配置 → 它的注释里字面含有 U+FFFD /「锟斤拷」字样
    const r = run([d, "--damaged"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已经被毁的文件");
    expect(r.stdout).toContain("src/Broken.java");
    // 关键：自己生成的配置不能出现在受损清单里（否则工具把自己的注释当成数据损坏）
    expect(r.stdout).not.toContain(".encoding-converter.json");
    // 聚焦输出：不该再造每扩展名画像表格 / 行尾统计
    expect(r.stdout).not.toContain("行尾风格");
    expect(r.stdout).not.toContain("--------");
  });
});
