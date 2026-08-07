import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { createEditToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations } from "../src/operations";
import { wrapEditToolWithEncodingPreview, clearUtf8Cache } from "../src/edit-preview";
import { clearConfigCache } from "../src/config";

// 1x1 red PNG — same fixture pi uses in tools.test.ts
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, "base64");

let root: string;
function putConfig(dir: string) {
  writeFileSync(join(dir, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
}
beforeEach(() => {
  clearConfigCache();
  clearUtf8Cache();
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

  it("exposes detectImageMimeType so Pi can take the image branch", async () => {
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const ops = makeReadOperations();
    expect(typeof ops.detectImageMimeType).toBe("function");
    await expect(ops.detectImageMimeType!(f)).resolves.toBe("image/png");
  });

  it("detectImageMimeType returns null for plain text", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, "hello\n", "utf-8");
    const ops = makeReadOperations();
    await expect(ops.detectImageMimeType!(f)).resolves.toBeNull();
  });

  it("with GB config: PNG bytes are returned unchanged (no iconv round-trip)", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    expect(out.equals(TINY_PNG)).toBe(true);
  });

  it("read tool returns an image content block for PNG (not text mojibake)", async () => {
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const def = createReadToolDefinition(root, { operations: makeReadOperations() });
    const result = await def.execute(
      "call-img",
      { path: f },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    // And not the text-only branch that dumps binary as Replaced UTF-8.
    const text = result.content.find((c) => c.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("Read image file");
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

describe("edit operations (read -> UTF-8 find/replace -> write, as Pi drives it)", () => {
  it("exposes readFile, writeFile and access", () => {
    const ops = makeEditOperations();
    expect(typeof ops.readFile).toBe("function");
    expect(typeof ops.writeFile).toBe("function");
    expect(typeof ops.access).toBe("function");
  });

  it("edits a GB18030 file and writes it back as GB18030 (encoding preserved)", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "code.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));
    const ops = makeEditOperations();

    // Pi's edit flow: read (decodes to UTF-8), find/replace on UTF-8 text, write back.
    const utf8 = (await ops.readFile(f)).toString("utf-8");
    expect(utf8).toBe("# 旧的注释\nx = 1\n");
    const edited = utf8.replace("旧的注释", "新的中文注释");
    await ops.writeFile(f, edited);

    // On disk must still be GB18030 bytes (not UTF-8) and decode correctly.
    const bytes = readFileSync(f);
    expect(iconv.decode(bytes, "GB18030")).toBe("# 新的中文注释\nx = 1\n");
    expect(bytes.equals(Buffer.from("# 新的中文注释\nx = 1\n", "utf-8"))).toBe(false);
  });

  it("preserves CRLF line endings through an edit round-trip", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "crlf.py");
    writeFileSync(f, iconv.encode("第一行\r\n第二行\r\n", "GB18030"));
    const ops = makeEditOperations();

    const utf8 = (await ops.readFile(f)).toString("utf-8");
    const edited = utf8.replace("第二行", "改后的第二行");
    await ops.writeFile(f, edited);

    const decoded = iconv.decode(readFileSync(f), "GB18030");
    expect(decoded).toBe("第一行\r\n改后的第二行\r\n");
  });

  it("passthrough: edits a UTF-8 file (no config) staying UTF-8", async () => {
    const f = join(root, "plain.txt");
    writeFileSync(f, "hello 世界\n", "utf-8");
    const ops = makeEditOperations();

    const utf8 = (await ops.readFile(f)).toString("utf-8");
    expect(utf8).toBe("hello 世界\n");
    await ops.writeFile(f, utf8.replace("世界", "world"));

    expect(readFileSync(f).toString("utf-8")).toBe("hello world\n");
  });
});

describe("integration: wrapped edit tool (execute path intact)", () => {
  it("execute() via the wrapped def still edits a GB18030 file correctly", async () => {
    putConfig(root);
    const f = join(root, "wrapped.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    // Re-create the exact def the extension registers and run execute().
    const baseDef = createEditToolDefinition(root, { operations: makeEditOperations() });
    const def = wrapEditToolWithEncodingPreview(baseDef, makeEditOperations(), root);
    const res = await def.execute(
      "call-x",
      { path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    // On disk must be GB18030 and decode correctly.
    expect(iconv.decode(readFileSync(f), "GB18030")).toBe("# 新的中文注释\nx = 1\n");
    // execute() returns the real diff (computed from the encoding-aware read).
    const diffText = res.details?.diff as string | undefined;
    expect(diffText).toBeDefined();
    expect(diffText).toContain("新的中文注释");
    expect(diffText).toContain("旧的注释");
  });
});
