// test/detector.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { detectEncoding, resetPythonCache } from "../src/encoding/detector";

const dir = mkdtempSync(join(tmpdir(), "detector-"));
afterEach(() => resetPythonCache());

describe("detector", () => {
  it("never throws and returns a DetectionResult shape for a GB file", async () => {
    const f = join(dir, "gb.txt");
    writeFileSync(f, iconv.encode("你好世界，这是一段中文测试内容。", "GB18030"));
    const result = await detectEncoding(f);
    expect(result).toHaveProperty("encoding");
    expect(result).toHaveProperty("confidence");
    expect(typeof result.confidence).toBe("number");
  });

  it("returns confidence 0 for empty file", async () => {
    const f = join(dir, "empty.txt");
    writeFileSync(f, Buffer.alloc(0));
    const result = await detectEncoding(f);
    expect(result.confidence).toBe(0);
  });
});
