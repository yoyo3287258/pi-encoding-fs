// test/p5-shell.test.ts — §5.5 P5：shell 输出转码（实验特性，默认关闭）
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { createOutputTranscoder, incompleteUtf8Tail } from "../src/encoding/stream-transcode";
import {
  dumpCommandPath,
  fileDumpEncodingForCommand,
  makeTranscodingShellOperations,
  lastShellTranscodeStats,
  osConsoleEncoding,
} from "../src/shell";
import { normalizeBashMode, shellRuleFor, clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes, drainShellNotes, peekEncodingNotes } from "../src/notify";
import { readPiShellSettings } from "../src/pi-settings";
import { putConfig } from "./helpers/tree";

const GB_TEXT = "订单服务初始化完成，报警阈值=85.5\n";

function collect(t: ReturnType<typeof createOutputTranscoder>, chunks: Buffer[]): Buffer {
  const outs: Buffer[] = [];
  for (const c of chunks) outs.push(t.push(c));
  outs.push(t.finish());
  return Buffer.concat(outs.filter((b) => b.length > 0));
}

function isUtf8ValidNow(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
});

describe("stream transcoder（纯逻辑，不 spawn）", () => {
  it("合法 UTF-8 输出：逐字节原样透传（这是零风险的保证）", () => {
    const raw = Buffer.from("hello 世界 ok\n", "utf-8");
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    const out = collect(t, [raw]);
    expect(out.equals(raw)).toBe(true);
    expect(t.stats().mode).toBe("passthrough");
  });

  it("GBK 输出 → 正确 UTF-8；**跨 chunk 的半个汉字**不能变成 U+FFFD", () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const chunks: Buffer[] = [];
    for (let i = 0; i < gbk.length; i += 3) chunks.push(gbk.subarray(i, i + 3)); // 3 字节切 → 必然拆字
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK", "GB2312"], fallbackEncoding: "GBK" });
    const out = collect(t, chunks);
    expect(out.toString("utf-8")).toBe(GB_TEXT);
    expect(out.toString("utf-8")).not.toContain("\uFFFD");
    expect(t.stats().mode).toBe("transcoded");
    expect(["GB18030", "GBK", "GB2312"]).toContain(t.stats().encoding); // GB 家族里选一个能无损回环的
    expect(t.stats().lossy).toBe(false);
  });

  it("二进制输出（含 NUL）永不碰", () => {
    const bin = Buffer.concat([Buffer.from([0x4c, 0x00, 0x65, 0x00]), Buffer.from("junk\xff\xfe", "latin1")]);
    const t = createOutputTranscoder({ candidates: ["GB18030"], fallbackEncoding: "GBK" });
    const out = collect(t, [bin]);
    expect(out.equals(bin)).toBe(true);
    expect(t.stats().mode).toBe("binary-passthrough");
  });

  it("preferredEncoding（倒文件 = 该文件自身读编码）优先于候选互校，但**仍让位于合法 UTF-8**", () => {
    const opts = { candidates: ["GB18030"], fallbackEncoding: "GB18030", preferredEncoding: "Big5" };
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const t1 = createOutputTranscoder(opts);
    expect(collect(t1, [gbk]).toString("utf-8")).toBe(iconv.decode(gbk, "Big5")); // 显式优先
    const utf8 = Buffer.from("已是 UTF-8\n", "utf-8");
    const t2 = createOutputTranscoder(opts);
    expect(collect(t2, [utf8]).equals(utf8)).toBe(true); // UTF-8 保护高于配置
    expect(t2.stats().mode).toBe("passthrough");
  });

  it("样本攒够前扣住输出（返回空 Buffer），finish 时一次给出", () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const t = createOutputTranscoder({ candidates: ["GBK"], fallbackEncoding: "GBK", sampleBytes: 10 });
    const first = t.push(gbk.subarray(0, 5));
    expect(first.length).toBe(0);
    const rest = collect(t, [gbk.subarray(5)]);
    expect(rest.toString("utf-8")).toBe(GB_TEXT);
  });

  it("字节不可判定时不猜；但显式编码（配置/倒文件）会接管，且转不完的部分标 lossy", () => {
    const bad = Buffer.concat([iconv.encode("订单", "GBK"), Buffer.from([0xff, 0xff])]);
    // 1) 无显式编码 → 不猜，原样透传
    const t0 = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    expect(collect(t0, [bad]).equals(bad)).toBe(true);
    expect(t0.stats().mode).toBe("binary-passthrough");
    // 2) 显式指定 GBK → 按 GBK 解释（只影响显示，磁盘无关），装不下的那两字节 → lossy
    const t1 = createOutputTranscoder({
      candidates: ["GB18030", "GBK"],
      fallbackEncoding: "GBK",
      preferredEncoding: "GBK",
    });
    const out = collect(t1, [bad]);
    expect(t1.stats().mode).toBe("transcoded");
    expect(t1.stats().lossy).toBe(true);
    expect(out.toString("utf-8")).toContain("订单"); // 能读的部分真的读出来了
  });

  it("空输出 → empty，且不改任何字节", () => {
    const t = createOutputTranscoder({ candidates: ["GBK"], fallbackEncoding: "GBK" });
    expect(collect(t, []).length).toBe(0);
    expect(t.stats().mode).toBe("empty");
  });

  // 真实工程活体跑出来的误判（P5 回归用例）：`head -c 120 .encoding-converter.json`
  // 把一个 UTF-8 框线字符从中间剪断 → 整块输出被当成 GBK 转码，结果更烂。
  it("末尾被截断的 UTF-8 序列不算“不是 UTF-8”（活体误判回归）", () => {
    const full = Buffer.from("# " + "\u2500".repeat(40) + "\n", "utf-8");
    const cut = full.subarray(0, 120); // 正好剪在多字节序列中间
    expect(isUtf8ValidNow(cut)).toBe(false);
    expect(incompleteUtf8Tail(cut)).toBeGreaterThan(0);
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK", "GB2312", "Big5"], fallbackEncoding: "GBK" });
    const out = collect(t, [cut]);
    expect(out.equals(cut)).toBe(true); // 原样，不转码
    expect(t.stats().mode).toBe("passthrough");
    expect(out.toString("utf-8")).not.toContain("\u9404"); // 不能出现 UTF-8 被按 GBK 解的二次乱码
  });

  it("反之：杂散续字节不能当截断 —— ASCII + 末尾一个 GBK 汉字仍要转码", () => {
    const mixed = Buffer.concat([Buffer.from("status ok ", "utf-8"), iconv.encode("好", "GBK")]);
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    const out = collect(t, [mixed]);
    expect(t.stats().mode).toBe("transcoded");
    expect(out.toString("utf-8")).toBe("status ok 好");
  });

  it("incompleteUtf8Tail 边界", () => {
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xe2, 0x94]))).toBe(2); // “─” 的前两字节
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xf0, 0x9f, 0x98]))).toBe(3); // emoji 前 3 字节
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xb4]))).toBe(0); // 杂散续字节
    expect(incompleteUtf8Tail(Buffer.from([0xe2, 0x94, 0x80]))).toBe(0); // 完整的“─”
    expect(incompleteUtf8Tail(Buffer.from("abc"))).toBe(0);
  });
});

describe("倒文件命令识别（type/cat/Get-Content）", () => {
  it("识别单文件；带通配符 / 多文件 / flag 的情况放弃", () => {
    expect(dumpCommandPath("type src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath('cat "src/a b.java"')).toBe("src/a b.java");
    expect(dumpCommandPath("ls -la | cat src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath("Get-Content src\\a.java")).toBe("src\\a.java");
    expect(dumpCommandPath("cat *.java")).toBeNull();
    expect(dumpCommandPath("cat a.java b.txt")).toBeNull();
    expect(dumpCommandPath("head -n 5 src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath("javac Foo.java")).toBeNull();
  });

  it("GBK 文件 → 该文件的读编码；UTF-8 文件 → null（本来就不用转）", async () => {
    const root = mkdtempSync(join(tmpdir(), "p5-dump-"));
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: "auto" });
    const gbkFile = join(root, "G.java");
    writeFileSync(gbkFile, iconv.encode(GB_TEXT, "GBK"));
    expect(await fileDumpEncodingForCommand(`cat ${gbkFile}`, root)).toBeTruthy();
    const utf8File = join(root, "U.java");
    writeFileSync(utf8File, GB_TEXT, "utf-8");
    expect(await fileDumpEncodingForCommand(`cat ${utf8File}`, root)).toBeNull();
  });
});

describe("配置开关（默认关闭）", () => {
  it("normalizeBashMode：垃圾值/未知编码都不会悄悄开启实验特性", () => {
    const w: string[] = [];
    expect(normalizeBashMode(undefined, "x", w)).toBe(false);
    expect(normalizeBashMode(false, "x", w)).toBe(false);
    expect(normalizeBashMode("off", "x", w)).toBe(false);
    expect(normalizeBashMode(true, "x", w)).toBe("auto");
    expect(normalizeBashMode("auto", "x", w)).toBe("auto");
    expect(normalizeBashMode("true", "x", w)).toBe("auto"); // 字符串 "true" 不是编码名 → 退 auto 并给 warning
    expect(normalizeBashMode("gbk", "x", w)).toBe("GBK");
    expect(normalizeBashMode("UTF-8", "x", w)).toBe(false); // 目标就是 UTF-8 = 不开
    expect(normalizeBashMode("ISO-2022-JP", "x", w)).toBe("auto"); // 转义序列编码不能当兜底
    expect(normalizeBashMode("NOPE-99", "x", w)).toBe("auto");
    expect(normalizeBashMode(123, "x", w)).toBe(false);
    expect(w.length).toBeGreaterThanOrEqual(5); // 每个纠正都留了可见 warning
  });

  it("shellRuleFor：无配置 / transcodeBash=false → null（连覆盖都不做，A-1）", () => {
    const root = mkdtempSync(join(tmpdir(), "p5-cfg-"));
    expect(shellRuleFor(root)).toBeNull();
    putConfig(root, { sourceEncoding: "GBK" });
    expect(shellRuleFor(root)).toBeNull(); // 没写 transcodeBash → 默认关
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: true });
    const rule = shellRuleFor(root)!;
    expect(rule.mode).toBe("auto");
    expect(rule.fileDump).toBe(true);
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: "Big5", bashFileDump: false });
    clearConfigCache();
    const r2 = shellRuleFor(root)!;
    expect(r2.mode).toBe("Big5");
    expect(r2.fileDump).toBe(false);
  });
});

describe("operations 包装（真 spawn，走 pi 自己的 bash 后端）", () => {
  // 用一个最小的 base：直接 spawn node 把指定字节写 stdout，模拟子进程输出。
  const byteEmitter = (buf: Buffer) => ({
    exec: async (_cmd: string, _cwd: string, opts: { onData: (b: Buffer) => void }) => {
      // 故意 3 字节一切，制造跨 chunk 的半个汉字
      for (let i = 0; i < buf.length; i += 3) opts.onData(buf.subarray(i, i + 3));
      return { exitCode: 0 };
    },
  });

  it("回归（CI 实测出的真 bug）：OS 码页不能压过字节判定", () => {
    // 英文 Windows / GitHub runner 的控制台码页是 437。早期版本把它当“判定优先级”
    // 传进判定器，结果 GBK 字节被按 437 解成 `╢⌐╡Ñ…` 框线乱码 —— 比不转更糟。
    // 现在码页只能待在 fallbackEncoding（仅当字节判不出来时）。
    const bytes = iconv.encode(GB_TEXT, "GBK");
    const t = createOutputTranscoder({
      candidates: ["GB18030", "GBK", "GB2312", "Big5"],
      priorityEncoding: "GBK",
      fallbackEncoding: "cp437",
    });
    const out = collect(t, [bytes]);
    expect(out.toString("utf-8")).toBe(GB_TEXT);
    expect(t.stats().encoding).not.toBe("cp437");
    expect(t.stats().basis).toContain("候选互校");
  });

  it("transcodeBash 生效：GBK 字节 → UTF-8，且回显一条 shell 提示", async () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const rule = {
      mode: "auto" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"],
      configDir: "/tmp",
      warnings: [],
    };
    const ops = makeTranscodingShellOperations(byteEmitter(gbk), rule);
    const out: Buffer[] = [];
    const r = await ops.exec("whatever", "/tmp", { onData: (b) => out.push(b) });
    expect(r.exitCode).toBe(0);
    const text = Buffer.concat(out).toString("utf-8");
    expect(text).toBe(GB_TEXT);
    expect(lastShellTranscodeStats()?.mode).toBe("transcoded");
    const notes = drainShellNotes();
    expect(notes.join(" ")).toContain("bash 输出已由");
    expect(notes.join(" ")).toContain("实验特性");
  });

  it("UTF-8 输出：一个字节都不改，也不留提示", async () => {
    const raw = Buffer.from("plain output 世界\n", "utf-8");
    const rule = {
      mode: "auto" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GB18030", "GBK"],
      configDir: "/tmp",
      warnings: [],
    };
    const ops = makeTranscodingShellOperations(byteEmitter(raw), rule);
    const out: Buffer[] = [];
    await ops.exec("x", "/tmp", { onData: (b) => out.push(b) });
    expect(Buffer.concat(out).equals(raw)).toBe(true);
    expect(peekEncodingNotes("\u0000shell-output")).toEqual([]);
    expect(drainShellNotes()).toEqual([]);
  });

  it("base 抛错（超时/中止）也要 flush 已产出的部分输出", async () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const base = {
      exec: async (_c: string, _cwd: string, opts: { onData: (b: Buffer) => void }) => {
        opts.onData(gbk.subarray(0, 8));
        throw new Error("timeout:5");
      },
    };
    const rule = {
      mode: "GBK" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GBK"],
      configDir: "/tmp",
      warnings: [],
    };
    const out: Buffer[] = [];
    await expect(makeTranscodingShellOperations(base, rule).exec("x", "/tmp", { onData: (b) => out.push(b) })).rejects.toThrow(
      /timeout/,
    );
    expect(Buffer.concat(out).toString("utf-8")).toBe(iconv.decode(gbk.subarray(0, 8), "GBK"));
  });

  it("OS 码页探测可用（本机应识别出 GBK 家族或至少返回可解码的编码名）", () => {
    const enc = osConsoleEncoding();
    if (enc) {
      expect(iconv.encodingExists(enc)).toBe(true);
      if (process.platform === "win32") expect(["GB18030", "Big5", "CP932", "CP949", "windows-1252", "cp437", "cp850", "cp852", "cp866", "windows-1250", "windows-1251", "windows-1254", "windows-1256"]).toContain(enc);
    }
  });
});

describe("pi shell 设置镜像（覆盖 bash 工具时不能丢掉用户的 shellPath/commandPrefix）", () => {
  it("项目级 .pi/settings.json 的两个键能被读到", () => {
    const root = mkdtempSync(join(tmpdir(), "p5-piset-"));
    const dir = join(root, ".pi");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ shellPath: "/bin/bash", shellCommandPrefix: "shopt -s x" }));
    const s = readPiShellSettings(root);
    expect(s.shellPath).toBe("/bin/bash");
    expect(s.shellCommandPrefix).toBe("shopt -s x");
  });

  it("坏 JSON / 缺文件 → 不抛错，返回空（让 pi 自己去报）", () => {
    const root = mkdtempSync(join(tmpdir(), "p5-piset2-"));
    writeFileSync(join(root, ".pi"), "not a dir"); // 冲突路径：读不出来而已
    expect(() => readPiShellSettings(root)).not.toThrow();
    const s = readPiShellSettings(root);
    for (const v of Object.values(s)) expect(typeof v).toBe("string");
  });
});
