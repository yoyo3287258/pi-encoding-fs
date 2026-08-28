import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import {
  isUtf8FileCached,
  clearUtf8Cache,
  wrapEditToolWithEncodingPreview,
} from "../src/edit-preview";
import { makeEditOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearUtf8Cache();
  root = mkdtempSync(join(tmpdir(), "preview-"));
});

describe("isUtf8FileCached — 同步预览路由（P3：改为复用 classifyBuffer + 配置）", () => {
  it("无配置目录 → true（透传：上游预览与我们的解码本来就是同一份字节）", () => {
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\n朱镕基\n", "GB18030"));
    expect(isUtf8FileCached(f)).toBe(true); // §8 A-1：无配置时行为必须与未装扩展一致
  });

  it("有配置时：GB18030 字节（含 GBK 扩展区 镕）→ false，走我们的预览渲染", () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\n朱镕基\n", "GB18030"));
    expect(isUtf8FileCached(f)).toBe(false);
  });

  it("§5.3 修正点：单字节编码按配置路由（旧的 TextDecoder 二分法做不到）", () => {
    writeFileSync(
      join(root, ".encoding-converter.json"),
      JSON.stringify({
        sourceEncoding: "UTF-8",
        overrides: [{ pattern: "*.txt", encoding: "ISO-8859-1", force: true }],
      }),
    );
    const latin = join(root, "legacy.txt");
    writeFileSync(latin, Buffer.from("caf\u00e9 na\u00efve \u00fcber\n", "latin1"));
    expect(isUtf8FileCached(latin)).toBe(false); // 我们的预览会按 ISO-8859-1 解出正确文本
    const outside = join(root, "other.md"); // 不匹配 override → 仍走 UTF-8 直读
    writeFileSync(outside, "caf\u00e9 na\u00efve\n", "utf-8");
    expect(isUtf8FileCached(outside)).toBe(true);
  });

  it("accepts UTF-8 with Chinese, ASCII-only, and UTF-8 with BOM", () => {
    const a = join(root, "u8.txt");
    writeFileSync(a, "hello 世界\n");
    expect(isUtf8FileCached(a)).toBe(true);

    const b = join(root, "ascii.txt");
    writeFileSync(b, "plain ascii only\n");
    expect(isUtf8FileCached(b)).toBe(true);

    const c = join(root, "bom.txt");
    writeFileSync(c, "\uFEFFhello 世界\n", "utf-8");
    expect(isUtf8FileCached(c)).toBe(true);
  });

  it("caches by mtime + 配置代数：文件改了或配置改了都要重新评估", () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cache.txt");
    writeFileSync(f, "hello\n", "utf-8");
    expect(isUtf8FileCached(f)).toBe(true);
    // Overwrite with GB bytes (mtime changes) -> cache should re-evaluate.
    writeFileSync(f, iconv.encode("你好\n", "GB18030"));
    expect(isUtf8FileCached(f)).toBe(false);
    // 删掉配置（透传接管）→ 即使 mtime 未变也必须重新评估
    rmSync(join(root, ".encoding-converter.json"));
    clearConfigCache();
    expect(isUtf8FileCached(f)).toBe(true);
  });

  it("defaults to true (upstream renderer) when the file does not exist yet", () => {
    expect(isUtf8FileCached(join(root, "nope.txt"))).toBe(true);
  });
});

describe("wrapEditToolWithEncodingPreview — renderCall dispatch", () => {
  beforeEach(() => {
    // A GB config so operations.readFile actually decodes GB18030 bytes (mirrors
    // how this extension is used in practice: a .encoding-converter.json exists).
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
  });

  // Simulate the call renderer the way tool-execution.js invokes it: it passes
  // (args, theme, context). We don't need a real theme — we only check WHICH
  // renderer ran, not what it drew.
  function makeTheme() {
    return {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
  }

  function fakeContext() {
    const state: Record<string, unknown> = {};
    return {
      state,
      lastComponent: undefined,
      invalidate: () => {},
      argsComplete: true,
    } as any;
  }

  it("GB file: bypasses the upstream renderer entirely (no false 'not found')", () => {
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    let upstreamTouched = false;
    const upstream = base.renderCall;
    base.renderCall = () => {
      upstreamTouched = true;
      return {} as any;
    };
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    // renderCall is sync; it returns a header component immediately and kicks
    // off an async diff computation that patches the component later.
    const out = wrapped.renderCall({ path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] }, makeTheme(), fakeContext());
    expect(out).toBeDefined();
    expect(upstreamTouched).toBe(false); // upstream (and thus computeEditsDiff) never reached
  });

  it("UTF-8 file: delegates to the upstream renderer (zero UX loss)", () => {
    const f = join(root, "u8.txt");
    writeFileSync(f, "hello world\n", "utf-8");

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    let upstreamTouched = false;
    const upstream = base.renderCall;
    base.renderCall = (...a: any[]) => {
      upstreamTouched = true;
      // Call the real upstream so we also exercise that it doesn't throw on a
      // plain UTF-8 file in this minimal harness.
      return upstream(...a);
    };
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    wrapped.renderCall({ path: f, edits: [{ oldText: "world", newText: "pi" }] }, makeTheme(), fakeContext());
    expect(upstreamTouched).toBe(true);
  });

  it("GB file: async diff resolves to a real diff string (Chinese matched)", async () => {
    const f = join(root, "gb2.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    const ctx = fakeContext();
    const out = wrapped.renderCall(
      { path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] },
      makeTheme(),
      ctx,
    ) as any;
    // The Box component stashes its preview on the instance; the async closure
    // writes there. operations.readFile may spawn python/chardet, so wait
    // generously and re-check.
    const st0 = (ctx.state.callComponent ?? out) as { preview?: { diff?: string; error?: string } };
    for (let i = 0; i < 40 && !st0.preview; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const st = st0;
    expect(st.preview).toBeDefined();
    expect(st.preview!.error).toBeUndefined();
    expect(st.preview!.diff).toContain("新的中文注释"); // added line present in the diff
    expect(st.preview!.diff).toContain("旧的注释"); // removed line present in the diff
  });

  it("GB file: when oldText is genuinely absent, surfaces an error string (no false diff)", async () => {
    const f = join(root, "gb3.py");
    writeFileSync(f, iconv.encode("# 旧注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;
    const ctx = fakeContext();
    wrapped.renderCall(
      { path: f, edits: [{ oldText: "不存在的文本", newText: "x" }] },
      makeTheme(),
      ctx,
    );
    const st0 = (ctx.state.callComponent ?? {}) as { preview?: { diff?: string; error?: string } };
    for (let i = 0; i < 40 && !st0.preview; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const st = st0;
    expect(st.preview).toBeDefined();
    expect(st.preview!.error).toBeTruthy();
    expect(st.preview!.diff).toBeUndefined();
  });
});
