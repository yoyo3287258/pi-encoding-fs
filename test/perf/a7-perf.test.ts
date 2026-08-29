import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../../src/operations";
import { putConfig } from "../../test/helpers/tree";
import { JAVA_SRC } from "../../test/fixtures/build";
describe("A-7 延迟", () => {
  // 这本质是性能验收用例（不是延迟基准）：它要造 301 个文件并跑 300 轮「读+改+写」，
  // 全套并行跑时 5s 默认超时会误报，所以单独给它 60s。
  it("read/write 平均延迟（闸门全开）", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "perf-"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", verifyWrite: true });
    const unit = iconv.encode(JAVA_SRC, "GBK");
    // 造 300 个接近真实尺寸(8.7KB) 的 GBK 文件 + 1 个 1MB
    const files: string[] = [];
    for (let i = 0; i < 300; i++) { const p = join(root, `F${i}.java`); writeFileSync(p, unit); files.push(p); }
    const big = join(root, "Big.java");
    const parts: Buffer[] = []; let n = 0; while (n < 1024 * 1024) { parts.push(unit); n += unit.length; }
    writeFileSync(big, Buffer.concat(parts).subarray(0, 1024 * 1024));
    const r = makeReadOperations(), w = makeWriteOperations();
    let t = Date.now();
    for (const f of files) { const s = (await r.readFile(f)).toString("utf-8"); await w.writeFile(f, s.replace("=85.5", "=90.0")); }
    const perOp = (Date.now() - t) / 300;
    t = Date.now(); const s1 = (await r.readFile(big)).toString("utf-8"); const tRead1 = Date.now() - t;
    t = Date.now(); await r.readFile(big); const tRead2 = Date.now() - t;
    t = Date.now(); await w.writeFile(big, s1.replace("=85.5", "=90.1")); const tWrite = Date.now() - t;
    console.log(`300 次「读+改+写」8.7KB GBK 文件：平均 ${perOp.toFixed(2)}ms/对`);
    console.log(`1MB GBK 文件：首次 read ${tRead1}ms（含判定）｜缓存后 read ${tRead2}ms｜带闸门 write ${tWrite}ms`);
    // 全套并行跑时 I/O 争用会放大绝对值；严格口径见 docs/P2-NOTES.md 的单次运行数字
    expect(perOp).toBeLessThan(60);
    expect(readFileSync(files[0]).equals(iconv.encode(JAVA_SRC.replace("=85.5", "=90.0"), "GBK"))).toBe(true);
  });
});
