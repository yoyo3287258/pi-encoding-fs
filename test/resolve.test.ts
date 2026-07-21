// test/resolve.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { resolveReadEncoding, resolveWriteEncoding } from "../src/resolve";
import { clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "resolve-"));
});

describe("resolveReadEncoding", () => {
  it("returns null (passthrough) when no config up the tree", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    expect(await resolveReadEncoding(f)).toBeNull();
  });

  it("config non-GB override forces UTF-8 (ignores chardet)", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({
      sourceEncoding: "GB18030",
      overrides: [{ pattern: "docs/**", sourceEncoding: "UTF-8" }],
    }));
    mkdirSync(join(root, "docs"));
    const f = join(root, "docs", "x.md");
    writeFileSync(f, iconv.encode("你好", "GB18030")); // even if bytes look GB
    expect(await resolveReadEncoding(f)).toBe("UTF-8");
  });

  it("config GB: falls back to sourceEncoding for a GB file", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "a.c");
    writeFileSync(f, iconv.encode("// 中文注释\nint main(){}\n", "GB18030"));
    // Whether chardet present or not, result must be a GB-family encoding
    const enc = await resolveReadEncoding(f);
    expect(enc).toMatch(/GB/i);
  });
});

describe("resolveWriteEncoding", () => {
  it("returns null (passthrough) when no config", async () => {
    expect(await resolveWriteEncoding(join(root, "new.txt"))).toBeNull();
  });

  it("new file uses nearest-config sourceEncoding without detection", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    expect(await resolveWriteEncoding(join(root, "new.c"))).toBe("GBK");
  });

  it("new file honors override", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({
      sourceEncoding: "GB18030",
      overrides: [{ pattern: "utf/**", sourceEncoding: "UTF-8" }],
    }));
    mkdirSync(join(root, "utf"));
    expect(await resolveWriteEncoding(join(root, "utf", "new.md"))).toBe("UTF-8");
  });
});
