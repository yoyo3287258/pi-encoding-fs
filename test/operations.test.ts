import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "ops-"));
});

describe("read operations", () => {
  it("passthrough: no config returns raw bytes unchanged", async () => {
    const f = join(root, "a.txt");
    const raw = Buffer.from("hello\n", "utf-8");
    writeFileSync(f, raw);
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    expect(out.equals(raw)).toBe(true);
  });

  it("with GB config: returns UTF-8 buffer that decodes to correct Chinese", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    writeFileSync(f, iconv.encode("你好世界", "GB18030"));
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    // Pi will decode this buffer as UTF-8:
    expect(out.toString("utf-8")).toBe("你好世界");
  });
});

describe("write operations", () => {
  it("passthrough: no config writes UTF-8", async () => {
    const f = join(root, "a.txt");
    const ops = makeWriteOperations();
    await ops.writeFile(f, "hello世界");
    expect(readFileSync(f).toString("utf-8")).toBe("hello世界");
  });

  it("with GB config: new file written as GB18030 bytes", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    const ops = makeWriteOperations();
    await ops.writeFile(f, "你好世界");
    const bytes = readFileSync(f);
    expect(bytes.equals(iconv.encode("你好世界", "GB18030"))).toBe(true);
    expect(bytes.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });

  it("preserves CRLF line endings of existing GB file on rewrite", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    writeFileSync(f, iconv.encode("a中\r\nb文\r\n", "GB18030"));
    const ops = makeWriteOperations();
    // Pi passes UTF-8 content with LF (its internal normalized form)
    await ops.writeFile(f, "a中\nb文\n");
    const decoded = iconv.decode(readFileSync(f), "GB18030");
    expect(decoded).toBe("a中\r\nb文\r\n");
  });
});
