// test/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNearestConfig, resolveOverrideEncoding, clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "cfg-"));
});

describe("findNearestConfig", () => {
  it("returns null when no config anywhere up the tree", async () => {
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(await findNearestConfig(deep)).toBeNull();
  });

  it("finds config in the same dir", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(root);
    expect(found?.config.sourceEncoding).toBe("GBK");
    expect(found?.configDir).toBe(root);
  });

  it("picks the DEEPEST (nearest) config when nested", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const sub = join(root, "legacy");
    mkdirSync(sub);
    writeFileSync(join(sub, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(sub);
    expect(found?.config.sourceEncoding).toBe("GBK");
    expect(found?.configDir).toBe(sub);
  });

  it("applies defaults for missing fields", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(root);
    expect(found?.config.confidenceThreshold).toBe(0.8);
  });
});

describe("resolveOverrideEncoding", () => {
  it("override glob is relative to configDir; most specific wins", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({
      sourceEncoding: "GB18030",
      overrides: [
        { pattern: "docs/**", sourceEncoding: "UTF-8" },
        { pattern: "docs/legacy/*.c", sourceEncoding: "GBK" },
      ],
    }));
    const found = (await findNearestConfig(root))!;
    expect(resolveOverrideEncoding(join(root, "docs", "readme.md"), found)).toBe("UTF-8");
    expect(resolveOverrideEncoding(join(root, "docs", "legacy", "x.c"), found)).toBe("GBK");
    expect(resolveOverrideEncoding(join(root, "src", "main.c"), found)).toBe("GB18030");
  });
});
