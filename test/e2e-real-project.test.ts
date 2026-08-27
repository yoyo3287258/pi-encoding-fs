// test/e2e-real-project.test.ts — 真实目标项目冒烟（**只在机器上有该项目时启用**，CI 上自动 skip）
//
// 安全边界：绝不写客户项目本体。这里把挑出来的真实文件**拷到 tmpdir**，
// 在副本上做 read→改 ASCII 片段→write，然后按各自编码回读校验；结束即删。
// 目的：证明判定层在合成 fixture 之外的真实 GBK 工程上也不损坏数据（§8 A-5 的前置证据）。
// 覆盖路径用环境变量指定：ENCFS_REAL_PROJECT=/path/to/project
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { classifyBuffer, clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";

const ROOT = process.env.ENCFS_REAL_PROJECT || "D:/temp/OAWSSMS";
const available = existsSync(ROOT);
const isUtf8 = (b: Buffer) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/** 从真实项目里挑代表文件：2 个 GBK java、2 个混在 GBK 树里的 UTF-8 java、1 个 GBK jsp */
function pickRealFiles(): string[] {
  const gbkJava: string[] = [];
  const utf8Java: string[] = [];
  const walkJava = (dir: string) => {
    if (!existsSync(dir)) return;
    if (gbkJava.length >= 2 && utf8Java.length >= 2) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".svn" || e.name === "target" || e.name === "out" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walkJava(p);
        continue;
      }
      if (!/\.java$/.test(e.name)) continue;
      const b = readFileSync(p);
      if (!b.some((x) => x > 127)) continue;
      if (isUtf8(b)) {
        if (utf8Java.length < 2) utf8Java.push(p);
      } else if (classifyBuffer(b, null).kind === "cjk" && gbkJava.length < 2) {
        gbkJava.push(p);
      }
      if (gbkJava.length >= 2 && utf8Java.length >= 2) return;
    }
  };
  walkJava(path.join(ROOT, "src"));
  const out = [...gbkJava, ...utf8Java];
  const jsp = path.join(ROOT, "WebContent/pages/login.jsp");
  if (existsSync(jsp) && !isUtf8(readFileSync(jsp))) out.push(jsp);
  return out.slice(0, 5);
}

/** 找一个已知被前人毁过的文件（内容里带 U+FFFD），用于「不雪上加霜」用例 */
function findDamagedFile(): string | null {
  let checked = 0;
  const walk = (dir: string): string | null => {
    if (!existsSync(dir) || checked > 3000) return null;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.name === ".svn" || e.name === "target" || e.name === "out") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
        continue;
      }
      if (!/\.(java|jsp|js|css)$/.test(e.name)) continue;
      checked++;
      const b = readFileSync(p);
      if (b.some((x) => x > 127) && isUtf8(b) && b.toString("utf-8").includes("\ufffd")) return p;
    }
    return null;
  };
  return walk(path.join(ROOT, "src")) ?? walk(path.join(ROOT, "WebContent"));
}

describe.skipIf(!available)(`真实项目冒烟：${ROOT}（无此目录时自动 skip）`, () => {
  let tmp: string;
  beforeEach(() => {
    clearConfigCache();
    clearClassifyCache();
    tmp = mkdtempSync(path.join(tmpdir(), "encfs-real-"));
    putConfig(tmp, {
      sourceEncoding: "GBK",
      writeEncoding: "GB18030",
      unmappable: "error",
      verifyWrite: true,
      protectUtf8: true,
      autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"],
    });
  });

  const files = available ? pickRealFiles() : [];

  it("挑到了真实样本文件（GBK java + 混入的 UTF-8 java + GBK jsp）", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => isUtf8(readFileSync(f)))).toBe(true);
    expect(files.some((f) => !isUtf8(readFileSync(f)))).toBe(true);
  });

  it("对已损坏文件（自带 U+FFFD）也不雪上加霜：读出多少 FFFD、写回还是多少", async () => {
    const base = findDamagedFile();
    expect(base, "该项目里应存在至少一个已损坏文件（扫描已证实 28 个）").toBeTruthy();
    const dst = path.join(tmp, "dirty.java");
    const orig = readFileSync(base!);
    writeFileSync(dst, orig);
    const text = (await makeReadOperations().readFile(dst)).toString("utf-8");
    const n = (text.match(/\ufffd/g) || []).length;
    expect(n).toBeGreaterThan(0);
    await makeWriteOperations().writeFile(dst, text.replace(/\s*$/, "\r\n"));
    const back = isUtf8(orig) ? readFileSync(dst).toString("utf-8") : iconv.decode(readFileSync(dst), "GB18030");
    expect((back.match(/\ufffd/g) || []).length).toBe(n);
    expect(statSync(base!).size).toBe(orig.length); // 原文件没被动过
  });

  for (const abs of files) {
    it(`编辑 ASCII 片段后磁盘编码类别不变：${path.relative(ROOT, abs).replace(/\\/g, "/")}`, async () => {
      const orig = readFileSync(abs);
      const dst = path.join(tmp, path.basename(abs));
      writeFileSync(dst, orig);
      const wasUtf8 = isUtf8(orig);
      const r = makeReadOperations();
      const w = makeWriteOperations();
      const text = (await r.readFile(dst)).toString("utf-8");
      // 该树里已有 28 个文件被前人用 UTF-8 硬编码工具毁过（带 U+FFFD / 「锟斤拷」）——
      // 不可逆，我们不能修好它，但必须保证**不新增**损坏，也不把已有的放大。
      const fffdOf = (s: string) => (s.match(/\ufffd/g) || []).length;
      const before = fffdOf(text);
      // 取一行非 ASCII 内容作为「仍未损坏」的探针（可能是中文，也可能是已有的锟斤拷）
      const probeLine = text.split(/\r?\n/).find((l) => /[^\x00-\x7f]/.test(l.trim())) ?? "";
      expect(probeLine.length, `该文件应有非 ASCII 行: ${abs}`).toBeGreaterThan(0);

      const edited = /(\d+\.\d)/.test(text)
        ? text.replace(/(\d+\.\d)/, (m) => String(Number(m) + 0.1))
        : text.replace(/\s*$/, "  \n");
      await w.writeFile(dst, edited);
      const after = readFileSync(dst);

      // ① 编码类别不变（UTF-8 仍是 UTF-8，GBK 仍是 GBK）
      expect(isUtf8(after)).toBe(wasUtf8);
      // ② 尺寸只应有编辑带来的微小变化（U+FFFD 泛滥会把 46B 撑成 94B）
      expect(Math.abs(after.length - orig.length)).toBeLessThan(40);
      // ③ 按自身编码回读：U+FFFD 数量必须与写前完全一致（= 本次操作零新增损坏）
      const back = wasUtf8 ? after.toString("utf-8") : iconv.decode(after, "GB18030");
      expect(fffdOf(back)).toBe(before);
      // ④ 探针行（未编辑那部分）仍逐字存在
      expect(back).toContain(probeLine.trim().slice(0, 12));
      expect(statSync(abs).size).toBe(orig.length); // 原文件没被动过
    });
  }

  it("清理 tmpdir 且不改动原项目", () => {
    rmSync(tmp, { recursive: true, force: true });
    expect(existsSync(tmp)).toBe(false);
    for (const f of files) expect(existsSync(f)).toBe(true);
  });
});
