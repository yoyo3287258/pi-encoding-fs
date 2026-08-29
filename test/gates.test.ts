// test/gates.test.ts — §3.3 三道硬闸门（T-5、T-6 的写入侧、A-6）
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeWriteOperations, type WriteSeam } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC, RARE_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  root = mkdtempSync(join(tmpdir(), "gates-"));
});

const gbkBytes = (text: string) => iconv.encode(text, "GBK");

describe("闸门 1 —— 不可映射字符必须响亮失败（修 §2 缺陷 3）", () => {
  it("T-5 GBK 文件写入生僻字 䶇 → 抛错，消息含 具体字符 / U+4D87 / 路径 / 建议 GB18030", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Rare.java");
    const original = gbkBytes("class A{}\r\n");
    writeFileSync(p, original);

    await expect(makeWriteOperations().writeFile(p, "class A{ /* 张䶇 𠀋 */ }\r\n")).rejects.toThrow();
    let msg = "";
    try {
      await makeWriteOperations().writeFile(p, "class A{ /* 张䶇 𠀋 */ }\r\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("闸门 1");
    expect(msg).toContain("拒写");
    expect(msg).toContain(p); // 带文件路径
    expect(msg).toContain("䶇");
    expect(msg).toContain("U+4D87");
    expect(msg).toContain("𠀋");
    expect(msg).toContain("U+2000B");
    expect(msg).toContain("GB18030");
    // 磁盘绝没有被改动（不会留下 0x3F）
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("T-5 drop-to-gb18030：自动升级且字节合法（既有 GBK 内容逐字节不变）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "drop-to-gb18030" });
    const p = join(root, "Up.java");
    writeFileSync(p, gbkBytes(JAVA_SRC));
    const text = iconv.decode(readFileSync(p), "GBK") + "// 新增：张䶇\r\n";
    await makeWriteOperations().writeFile(p, text);
    const after = readFileSync(p);
    expect(after.includes(0x3f)).toBe(false); // 没有 '?'
    const dec = iconv.decode(after, "GB18030");
    expect(dec).toContain("䶇");
    expect(dec).toContain("报警阈值=85.5"); // 原 GBK 内容完好
    // 关键：未新增那行之外的字节，GBK 前缀必须逐字节不变（P-4）
    const prefix = gbkBytes(JAVA_SRC);
    expect(after.subarray(0, prefix.length).equals(prefix)).toBe(true);
  });

  it("T-5 escape：转成 \\uXXXX 文本，文件仍是 GBK", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "escape" });
    const p = join(root, "Esc.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 䶇 */ }\r\n");
    const after = readFileSync(p);
    const dec = iconv.decode(after, "GBK");
    expect(dec).toContain("\\u4d87"); // 转义文本
    expect(dec).not.toContain("䶇");
    expect(after.includes(0x3f)).toBe(false);
  });

  it("纯 ASCII / 普通中文不误报（实测事实速查里的反例）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Ok.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 订单服务 OrderService 123 */ }\r\n\t\r\n");
    expect(iconv.decode(readFileSync(p), "GBK")).toContain("订单服务");
  });
});

describe("闸门 2 —— 写后回读自校验 + 回滚", () => {
  /** 故意「只把第一次落盘写歪」的落盘实现：用来验证回滚（回滚那一次必须正常写） */
  const corruptOnceSeam = (): WriteSeam => {
    let n = 0;
    return {
      writeBytes: async (abs: string, bytes: Buffer) => {
        n++;
        writeFileSync(abs, n === 1 ? Buffer.concat([bytes, Buffer.from([0x00, 0x41])]) : bytes);
      },
    };
  };

  it("写出的字节与预期不一致 → 抛「闸门 2」并回滚成写前内容", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Roll.java");
    const original = gbkBytes(JAVA_SRC);
    writeFileSync(p, original);
    const { seam } = { seam: corruptOnceSeam() };
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, iconv.decode(original, "GBK").replace("=85.5", "=90.0"));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("闸门 2");
    expect(msg).toContain("已回滚");
    expect(readFileSync(p).equals(original)).toBe(true); // 回滚后与写前逐字节相等
  });

  it("落盘直接抛错 → 磁盘保持原样并把原因带出来", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Boom.java");
    const original = gbkBytes(JAVA_SRC);
    writeFileSync(p, original);
    const seam: WriteSeam = {
      writeBytes: async () => {
        throw new Error("EBUSY: resource busy or locked");
      },
    };
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, "新内容");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("EBUSY");
    expect(msg).toContain("磁盘保持原样");
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("新建文件写歪 → 删掉半成品（不留垃圾）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Fresh.java");
    const seam = corruptOnceSeam();
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, "class Fresh{}\r\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("写前不存在");
    expect(existsSync(p)).toBe(false);
  });

  it("verifyWrite:false 时跳过闸门 2（同一 corruptSeam 不再报错，证明确实是闸门在拦）", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030", verifyWrite: false });
    const p = join(root, "NoVerify.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    const seam = corruptOnceSeam();
    await makeWriteOperations(seam).writeFile(p, "class A{ /* 中文 */ }\r\n");
    const after = readFileSync(p);
    expect(after.subarray(after.length - 2).equals(Buffer.from([0x00, 0x41]))).toBe(true); // 脏字节留着
  });

  it("正常路径：原子替换不留临时文件，写后内容可被同一判定链读出", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Good.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 中文 */ }\r\n");
    expect(readFileSync(p).equals(gbkBytes("class A{ /* 中文 */ }\r\n"))).toBe(true);
    const leftovers = readdirSync(root).filter((f) => f.includes(".encfs.tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("闸门 3 —— 拿不准就不写（§3.2 的 unknown/binary/BOM 三个拒绝点，端到端）", () => {
  it("T-6 缺陷 4 现场：content 带前导 U+FEFF 而目标是 GB 系 → 抛错且磁盘不出现 0x3F", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom.java");
    const original = gbkBytes("标题：测试\n");
    writeFileSync(p, original);
    let msg = "";
    try {
      await makeWriteOperations().writeFile(p, "\ufeff标题：测试2\n"); // pi 的 edit 会把 BOM 一起传进来
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("UTF-8 with BOM");
    expect(msg).toContain("0x3F");
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("unknown / binary 的写入被拒（闸门 3 前两个分支）", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const u = join(root, "unknown.bin");
    writeFileSync(u, Buffer.from("中文中间被截断", "utf-8").subarray(0, 7));
    await expect(makeWriteOperations().writeFile(u, "x\n")).rejects.toThrow(/UNKNOWN/);
    const b = join(root, "b.class");
    writeFileSync(b, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x01]));
    await expect(makeWriteOperations().writeFile(b, "x\n")).rejects.toThrow(/二进制/);
  });

  it("被污染的读结果（U+FFFD 乱码）写回 GB 系 → 闸门 3 拒绝（§1 事故的镜像）", async () => {
    putConfig(root, { overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const p = join(root, "Mojibake.java");
    const utf8 = Buffer.from(RARE_SRC.replace("䶇", "").trim(), "utf-8");
    writeFileSync(p, utf8);
    // 按 GBK 强解一份合法 UTF-8 → 必然产生 U+FFFD
    const dirty = iconv.decode(utf8, "GBK");
    expect(dirty).toContain("\ufffd");
    await expect(makeWriteOperations().writeFile(p, dirty)).rejects.toThrow(/U\+FFFD/);
    expect(readFileSync(p).equals(utf8)).toBe(true);
  });
});
