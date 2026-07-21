# pi-encoding-fs 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个标准 Pi 扩展包，用编码感知的 `read`/`write`/`edit`/`grep` 覆盖 Pi 内置同名工具，透明处理 GB18030/GBK/GB2312 文件，同时保留 Pi 原生 TUI（diff/高亮/行号）。

**Architecture:** 常驻注册四个同名覆盖工具。read/write/edit 复用 Pi 导出的 `createXxxToolDefinition(cwd, { operations })`，只在 `operations` 层注入编码转换（Pi 在 UTF-8 世界里做 find/replace + diff + 渲染）。grep 复用 Pi 的 grep schema/description，但自实现 `execute` 以支持搜 GB 文件里的中文。是否转换由**逐文件向上就近查找 `.encoding-converter.json`** 决定；找不到则透传 UTF-8（等价内置）。

**Tech Stack:** TypeScript（jiti 直跑，tsc 仅 typecheck）、`@sinclair/typebox`（参数 schema）、`iconv-lite`（GB⇄UTF-8）、`micromatch`（override glob）、Python+chardet 子进程（编码检测，沿用现有实现）、vitest（测试）。Pi API 来自 `@earendil-works/pi-coding-agent`。

## Global Constraints

- 包必须是标准 Pi 包：`package.json` 的 `keywords` 含 `pi-package` 与 `pi-extension`，且有 `pi.extensions: ["./src/index.ts"]` 字段。
- Pi 相关依赖（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`）放 `peerDependencies`，版本 `>=0.80.0`。
- 运行时依赖 `iconv-lite`、`micromatch` 放 `dependencies`。
- 参数 schema 用 `@sinclair/typebox` 的 `Type`（不是 zod）。
- 编码检测沿用现有 Python+chardet 子进程实现（`detector.ts`），不引入纯 JS chardet 包。Python 不可用时检测返回 `{encoding:null,confidence:0}`，逻辑自动回落到配置 `sourceEncoding`。
- 覆盖工具必须**不提供** `renderCall`/`renderResult`（read/write/edit），以继承 Pi 内置渲染。
- 配置解析语义：对每个被操作文件，从其目录向上就近查找 `.encoding-converter.json`，用最深的一个；overrides 的 glob 相对该配置文件所在目录解析；找不到则透传 UTF-8。
- 目录级配置查找结果需缓存；`session_start` 与 `/reload`（`resources_discover` reason `"reload"`）时清空缓存。
- 所有工具名必须与 Pi 内置完全一致：`read`、`write`、`edit`、`grep`。
- 新架构**不做** allowedDirectories / 路径越界校验（工具常驻、逐文件判定，路径由 Pi 骨架处理）。不移植 `path-validation.ts` / `path-utils.ts`。

## File Structure

```
pi-encoding-fs/
├── package.json                        Pi 包 manifest
├── tsconfig.json                       typecheck 配置
├── vitest.config.ts                    测试配置
├── .gitignore
├── README.md
├── src/
│   ├── index.ts                        扩展入口：常驻注册 4 工具 + 清缓存
│   ├── config.ts                       就近查找 + 加载 .encoding-converter.json + override 解析 + 缓存
│   ├── encoding/
│   │   ├── converter.ts                GB⇄UTF-8 编解码 + resolveFileEncoding（移植）
│   │   ├── detector.ts                 Python+chardet 检测（移植）
│   │   └── line-endings.ts             CRLF/LF 检测与还原（移植）
│   ├── resolve.ts                      核心：给定文件路径 → 决定编码（就近配置 + 检测），透传返回 null
│   ├── operations.ts                   编码感知的 read/write/edit operations 工厂
│   └── grep.ts                         G2：编码感知 grep 的 execute + schema 复用
└── test/
    ├── config.test.ts
    ├── converter.test.ts
    ├── line-endings.test.ts
    ├── resolve.test.ts
    ├── operations.test.ts
    └── grep.test.ts
```

---

### Task 1: 项目脚手架与 Pi 包 manifest

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: 无
- Produces: 可运行 `npm install` / `npm run typecheck` / `npm test` 的项目骨架。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "pi-encoding-fs",
  "version": "0.1.0",
  "description": "Encoding-aware read/write/edit/grep for Pi — transparent GB18030/GBK/GB2312 support",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi-extension", "encoding", "gb18030", "utf-8"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.80.0",
    "@earendil-works/pi-coding-agent": ">=0.80.0",
    "@earendil-works/pi-tui": ">=0.80.0"
  },
  "dependencies": {
    "iconv-lite": "^0.6.3",
    "micromatch": "^4.0.8"
  },
  "devDependencies": {
    "@sinclair/typebox": "^0.34.0",
    "@types/micromatch": "^4.0.10",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 写 vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 5: 安装依赖并验证**

Run: `npm install && npm run typecheck`
Expected: 安装成功；typecheck 通过（此时 src 为空，tsc 无错误退出码 0）。

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold pi-encoding-fs package"
```

---

### Task 2: 移植编码核心模块（converter / line-endings）

从参考仓库 `filesystemex/src/encoding/` 移植纯逻辑模块。这两个模块无外部进程依赖，先做，便于后续任务复用与测试。

**Files:**
- Create: `src/encoding/converter.ts`
- Create: `src/encoding/line-endings.ts`
- Test: `test/converter.test.ts`
- Test: `test/line-endings.test.ts`

**Interfaces:**
- Consumes: `iconv-lite`
- Produces:
  - `isGBEncoding(encoding: string): boolean`
  - `resolveFileEncoding(detectedEncoding: string | null, detectedConfidence: number, resolvedSourceEncoding: string, confidenceThreshold: number): string`
  - `decodeToUtf8(buffer: Buffer, encoding: string): string`
  - `encodeFromUtf8(text: string, encoding: string): Buffer`
  - `type LineEndingStyle = 'CRLF' | 'LF'`
  - `detectLineEnding(buffer: Buffer): LineEndingStyle`
  - `restoreLineEndings(text: string, style: LineEndingStyle): string`

- [ ] **Step 1: 写 converter 的失败测试**

```typescript
// test/converter.test.ts
import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import { isGBEncoding, resolveFileEncoding, decodeToUtf8, encodeFromUtf8 } from "../src/encoding/converter";

describe("converter", () => {
  it("isGBEncoding recognizes GB family", () => {
    expect(isGBEncoding("GB18030")).toBe(true);
    expect(isGBEncoding("gbk")).toBe(true);
    expect(isGBEncoding("UTF-8")).toBe(false);
  });

  it("round-trips Chinese text through GB18030", () => {
    const gb = encodeFromUtf8("你好世界", "GB18030");
    expect(decodeToUtf8(gb, "GB18030")).toBe("你好世界");
    // GB18030 bytes differ from UTF-8 bytes
    expect(gb.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });

  it("resolveFileEncoding: config non-GB always UTF-8", () => {
    expect(resolveFileEncoding("GB2312", 0.99, "UTF-8", 0.8)).toBe("UTF-8");
  });

  it("resolveFileEncoding: config GB trusts high-confidence GB detection", () => {
    expect(resolveFileEncoding("GBK", 0.9, "GB18030", 0.8)).toBe("GBK");
  });

  it("resolveFileEncoding: config GB falls back when detection weak/non-GB", () => {
    expect(resolveFileEncoding("UTF-8", 0.99, "GB18030", 0.8)).toBe("GB18030");
    expect(resolveFileEncoding("GBK", 0.5, "GB18030", 0.8)).toBe("GB18030");
    expect(resolveFileEncoding(null, 0, "GB18030", 0.8)).toBe("GB18030");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/converter.test.ts`
Expected: FAIL（模块不存在 / 无法解析 `../src/encoding/converter`）。

- [ ] **Step 3: 写 converter.ts 实现**

```typescript
// src/encoding/converter.ts
import iconv from "iconv-lite";

export function isGBEncoding(encoding: string): boolean {
  const upper = encoding.toUpperCase();
  return upper.includes("GB") || upper === "GB2312" || upper === "GBK" || upper === "GB18030";
}

export function resolveFileEncoding(
  detectedEncoding: string | null,
  detectedConfidence: number,
  resolvedSourceEncoding: string,
  confidenceThreshold: number,
): string {
  if (!isGBEncoding(resolvedSourceEncoding)) {
    return "UTF-8";
  }
  if (detectedEncoding && detectedConfidence >= confidenceThreshold && isGBEncoding(detectedEncoding)) {
    return detectedEncoding;
  }
  return resolvedSourceEncoding;
}

export function decodeToUtf8(buffer: Buffer, encoding: string): string {
  return iconv.decode(buffer, encoding);
}

export function encodeFromUtf8(text: string, encoding: string): Buffer {
  return iconv.encode(text, encoding);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/converter.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: 写 line-endings 失败测试**

```typescript
// test/line-endings.test.ts
import { describe, it, expect } from "vitest";
import { detectLineEnding, restoreLineEndings } from "../src/encoding/line-endings";

describe("line-endings", () => {
  it("detects CRLF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\r\nb\r\nc\n"))).toBe("CRLF");
  });
  it("detects LF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\nb\nc\r\n"))).toBe("LF");
  });
  it("restores to CRLF", () => {
    expect(restoreLineEndings("a\nb\n", "CRLF")).toBe("a\r\nb\r\n");
  });
  it("restores to LF (normalizes existing CRLF first)", () => {
    expect(restoreLineEndings("a\r\nb\n", "LF")).toBe("a\nb\n");
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run test/line-endings.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 7: 写 line-endings.ts 实现**

```typescript
// src/encoding/line-endings.ts
export type LineEndingStyle = "CRLF" | "LF";

export function detectLineEnding(buffer: Buffer): LineEndingStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && i + 1 < buffer.length && buffer[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (buffer[i] === 0x0a) {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) {
    return process.platform === "win32" ? "CRLF" : "LF";
  }
  return crlf >= lf ? "CRLF" : "LF";
}

export function restoreLineEndings(text: string, style: LineEndingStyle): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (style === "CRLF") {
    return normalized.replace(/\n/g, "\r\n");
  }
  return normalized;
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run test/line-endings.test.ts`
Expected: PASS（4 个用例全过）。

- [ ] **Step 9: Commit**

```bash
git add src/encoding/converter.ts src/encoding/line-endings.ts test/converter.test.ts test/line-endings.test.ts
git commit -m "feat(encoding): port converter and line-ending modules"
```

---

### Task 3: 移植编码检测（Python + chardet 子进程）

**Files:**
- Create: `src/encoding/detector.ts`
- Test: `test/detector.test.ts`

**Interfaces:**
- Consumes: `node:child_process`
- Produces:
  - `interface DetectionResult { encoding: string | null; confidence: number }`
  - `detectEncoding(filePath: string): Promise<DetectionResult>` — Python 不可用或出错时返回 `{ encoding: null, confidence: 0 }`
  - `resetPythonCache(): void`

- [ ] **Step 1: 写失败测试**

测试不依赖真实 chardet 结果（CI 可能无 Python），只验证契约：Python 缺失时优雅降级、检测 GB 文件时不抛异常。

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/detector.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 detector.ts 实现**

```typescript
// src/encoding/detector.ts
import { spawn, execSync } from "node:child_process";

export interface DetectionResult {
  encoding: string | null;
  confidence: number;
}

let _pythonCmd: string | null = null;

async function findPython(): Promise<string> {
  if (_pythonCmd) return _pythonCmd;
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execSync(cmd + " --version", { stdio: "ignore" });
      _pythonCmd = cmd;
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error("Python not found");
}

export function resetPythonCache(): void {
  _pythonCmd = null;
}

const PY_SCRIPT = [
  "import chardet, sys, json",
  "try:",
  "    with open(sys.argv[1], 'rb') as f:",
  "        data = f.read(32768)",
  "        if not data:",
  '            print(json.dumps({"encoding": None, "confidence": 0.0}))',
  "        else:",
  "            r = chardet.detect(data)",
  '            print(json.dumps({"encoding": r.get("encoding"), "confidence": r.get("confidence", 0.0)}))',
  "except Exception:",
  '    print(json.dumps({"encoding": None, "confidence": 0.0}))',
].join("\n");

export async function detectEncoding(filePath: string): Promise<DetectionResult> {
  let pythonCmd: string;
  try {
    pythonCmd = await findPython();
  } catch {
    return { encoding: null, confidence: 0 };
  }

  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, ["-c", PY_SCRIPT, filePath]);
    let output = "";
    proc.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ encoding: null, confidence: 0 });
        return;
      }
      try {
        const r = JSON.parse(output.trim());
        resolve({ encoding: r.encoding || null, confidence: r.confidence || 0 });
      } catch {
        resolve({ encoding: null, confidence: 0 });
      }
    });
    proc.on("error", () => resolve({ encoding: null, confidence: 0 }));
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/detector.test.ts`
Expected: PASS（2 个用例；无论 Python 是否安装均通过，因契约允许降级）。

- [ ] **Step 5: Commit**

```bash
git add src/encoding/detector.ts test/detector.test.ts
git commit -m "feat(encoding): port Python+chardet encoding detector"
```

---

### Task 4: 就近配置查找与 override 解析（config.ts）

实现核心配置语义：向上就近查找 `.encoding-converter.json`，加载并解析，override glob 相对配置目录解析，结果缓存。

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `micromatch`, `node:fs`, `node:path`
- Produces:
  - `interface OverrideRule { pattern: string; sourceEncoding: string }`
  - `interface EncodingConfig { sourceEncoding: string; confidenceThreshold: number; overrides?: OverrideRule[] }`
  - `interface FoundConfig { config: EncodingConfig; configDir: string }`
  - `findNearestConfig(startDir: string): Promise<FoundConfig | null>` — 从 startDir 向上逐级找，返回最深（最近）的一个及其目录；找不到返回 `null`
  - `resolveOverrideEncoding(absFilePath: string, found: FoundConfig): string` — 根据 override glob（相对 configDir）返回该文件应用的 sourceEncoding，无匹配返回 `config.sourceEncoding`
  - `clearConfigCache(): void`

- [ ] **Step 1: 写失败测试**

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 config.ts 实现**

```typescript
// src/config.ts
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";

export interface OverrideRule {
  pattern: string;
  sourceEncoding: string;
}

export interface EncodingConfig {
  sourceEncoding: string;
  confidenceThreshold: number;
  overrides?: OverrideRule[];
}

export interface FoundConfig {
  config: EncodingConfig;
  configDir: string;
}

const DEFAULTS = { sourceEncoding: "GB18030", confidenceThreshold: 0.8 };

// dir -> EncodingConfig | null (checked, none found in this exact dir)
const dirCache = new Map<string, EncodingConfig | null>();

export function clearConfigCache(): void {
  dirCache.clear();
}

async function loadConfigInDir(dir: string): Promise<EncodingConfig | null> {
  if (dirCache.has(dir)) return dirCache.get(dir) ?? null;
  const p = path.join(dir, ".encoding-converter.json");
  try {
    const parsed = JSON.parse(await readFile(p, "utf-8"));
    const config: EncodingConfig = { ...DEFAULTS, ...parsed };
    dirCache.set(dir, config);
    return config;
  } catch {
    dirCache.set(dir, null);
    return null;
  }
}

export async function findNearestConfig(startDir: string): Promise<FoundConfig | null> {
  let cur = path.resolve(startDir);
  while (true) {
    const config = await loadConfigInDir(cur);
    if (config) return { config, configDir: cur };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function scoreSpecificity(pattern: string): number {
  if (!pattern) return 0;
  let score = 0;
  for (const seg of pattern.split("/")) {
    if (seg === "**") score += 1;
    else if (seg === "*") score += 2;
    else if (seg.includes("*") || seg.includes("?")) score += 5;
    else score += 10;
  }
  return score;
}

export function resolveOverrideEncoding(absFilePath: string, found: FoundConfig): string {
  const { config, configDir } = found;
  if (!config.overrides?.length) return config.sourceEncoding;
  const rel = path.relative(configDir, absFilePath).replace(/\\/g, "/");
  const matches = config.overrides
    .map((rule, index) => ({ rule, score: scoreSpecificity(rule.pattern), index }))
    .filter((item) => {
      if (!item.rule.pattern) return false;
      const isBare = !item.rule.pattern.includes("/");
      return micromatch.isMatch(rel, item.rule.pattern, isBare ? { matchBase: true } : undefined);
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return matches[0]?.rule.sourceEncoding ?? config.sourceEncoding;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): nearest-config lookup with configDir-relative overrides"
```

---

### Task 5: 编码决策层（resolve.ts）

把 config + detector + converter 组合成一个单一入口：给定一个绝对文件路径，决定它应用什么编码；**无就近配置时返回 `null`（表示透传 UTF-8）**。operations 和 grep 都靠它判定。

**Files:**
- Create: `src/resolve.ts`
- Test: `test/resolve.test.ts`

**Interfaces:**
- Consumes: `findNearestConfig`, `resolveOverrideEncoding`（Task 4）；`detectEncoding`（Task 3）；`resolveFileEncoding`, `isGBEncoding`（Task 2）；`node:fs`
- Produces:
  - `resolveReadEncoding(absFilePath: string): Promise<string | null>` — 返回该文件读取时应用的实际编码（如 `"GB18030"`/`"GBK"`/`"UTF-8"`）；无就近配置返回 `null`。已处理“chardet 误判”：配置非 GB → UTF-8；配置 GB → 仅高置信 GB 检测才用检测值，否则回落配置 sourceEncoding。
  - `resolveWriteEncoding(absFilePath: string): Promise<string | null>` — 写入（含 edit 的写回）时的目标编码。若文件已存在，同 read 逻辑（保持原文件编码）；若不存在（新文件），用就近配置的 override/sourceEncoding（不做检测）；无就近配置返回 `null`。

- [ ] **Step 1: 写失败测试**

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/resolve.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 resolve.ts 实现**

```typescript
// src/resolve.ts
import { access } from "node:fs/promises";
import * as path from "node:path";
import { findNearestConfig, resolveOverrideEncoding } from "./config";
import { detectEncoding } from "./encoding/detector";
import { resolveFileEncoding, isGBEncoding } from "./encoding/converter";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveReadEncoding(absFilePath: string): Promise<string | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;

  const sourceEncoding = resolveOverrideEncoding(absFilePath, found);

  // Config explicitly non-GB (e.g. UTF-8 override) -> trust config, skip chardet.
  if (!isGBEncoding(sourceEncoding)) {
    return "UTF-8";
  }

  // Config GB -> only trust high-confidence GB detection, else fall back.
  const detection = await detectEncoding(absFilePath);
  return resolveFileEncoding(
    detection.encoding,
    detection.confidence,
    sourceEncoding,
    found.config.confidenceThreshold,
  );
}

export async function resolveWriteEncoding(absFilePath: string): Promise<string | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;

  // Existing file: preserve its actual encoding (same logic as read).
  if (await fileExists(absFilePath)) {
    return resolveReadEncoding(absFilePath);
  }

  // New file: use nearest-config override/sourceEncoding, no detection.
  const sourceEncoding = resolveOverrideEncoding(absFilePath, found);
  return isGBEncoding(sourceEncoding) ? sourceEncoding : "UTF-8";
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/resolve.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/resolve.ts test/resolve.test.ts
git commit -m "feat(resolve): per-file encoding decision with passthrough fallback"
```

---

### Task 6: 编码感知 operations 工厂（operations.ts）

实现注入给 Pi `createReadTool`/`createWriteTool`/`createEditTool` 的 operations。每个方法
先用 `resolveReadEncoding`/`resolveWriteEncoding` 判定：返回 `null` 时走普通 UTF-8 磁盘 IO（透传）；
否则做 GB⇄UTF-8 转换 + 行尾保持。

**关键设计点（read）**：Pi 拿到 `readFile` 返回的 Buffer 后按 UTF-8 解码。所以有配置时，
我们把磁盘上的 GB 字节 → 解码为 UTF-8 字符串 → **重新编码为 UTF-8 Buffer** 返回。

**Files:**
- Create: `src/operations.ts`
- Test: `test/operations.test.ts`

**Interfaces:**
- Consumes: `resolveReadEncoding`, `resolveWriteEncoding`（Task 5）；`decodeToUtf8`, `encodeFromUtf8`（Task 2）；`detectLineEnding`, `restoreLineEndings`（Task 2）；`node:fs`；Pi 类型 `ReadOperations`, `WriteOperations`, `EditOperations`（从 `@earendil-works/pi-coding-agent`）
- Produces:
  - `makeReadOperations(): ReadOperations`
  - `makeWriteOperations(): WriteOperations`
  - `makeEditOperations(): EditOperations`

- [ ] **Step 1: 写失败测试**

```typescript
// test/operations.test.ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/operations.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 operations.ts 实现**

```typescript
// src/operations.ts
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
} from "@earendil-works/pi-coding-agent";
import { resolveReadEncoding, resolveWriteEncoding } from "./resolve";
import { decodeToUtf8, encodeFromUtf8 } from "./encoding/converter";
import { detectLineEnding, restoreLineEndings, type LineEndingStyle } from "./encoding/line-endings";

async function readAsUtf8Buffer(absPath: string): Promise<Buffer> {
  const raw = await readFile(absPath);
  const enc = await resolveReadEncoding(absPath);
  if (!enc || enc.toUpperCase() === "UTF-8") {
    return raw; // passthrough / already UTF-8
  }
  const text = decodeToUtf8(raw, enc);
  return Buffer.from(text, "utf-8");
}

async function detectExistingLineEnding(absPath: string): Promise<LineEndingStyle | null> {
  try {
    const raw = await readFile(absPath);
    return detectLineEnding(raw);
  } catch {
    return null;
  }
}

async function writeEncoded(absPath: string, utf8content: string): Promise<void> {
  const enc = await resolveWriteEncoding(absPath);
  if (!enc || enc.toUpperCase() === "UTF-8") {
    await writeFile(absPath, utf8content, "utf-8"); // passthrough / UTF-8
    return;
  }
  const style = await detectExistingLineEnding(absPath);
  const restored = style ? restoreLineEndings(utf8content, style) : utf8content;
  await writeFile(absPath, encodeFromUtf8(restored, enc));
}

export function makeReadOperations(): ReadOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    access: (absPath) => access(absPath, constants.R_OK),
  };
}

export function makeWriteOperations(): WriteOperations {
  return {
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  };
}

export function makeEditOperations(): EditOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    access: (absPath) => access(absPath, constants.R_OK | constants.W_OK),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/operations.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 通过（验证从 Pi 包导入的 `ReadOperations`/`WriteOperations`/`EditOperations` 类型匹配）。

- [ ] **Step 6: Commit**

```bash
git add src/operations.ts test/operations.test.ts
git commit -m "feat(operations): encoding-aware read/write/edit operations"
```

---

### Task 7: 编码感知 grep（G2 自实现，grep.ts）

grep 不能用 Pi 骨架（`GrepOperations` 不暴露搜索钩子）。自实现 `execute`，**schema 与 Pi 内置
grep 一致**（`pattern/path/glob/ignoreCase/literal/context/limit`）以保持透明。对每个候选文件
就近查找配置：有 GB 配置的文件 → 用 iconv 把 pattern 编为 GB 字节、对该文件搜索、匹配行解码回 UTF-8；
无配置或 UTF-8 文件 → 直接按 UTF-8 搜索。

**实现策略（控制风险）**：不移植 filesystemex 那 546 行的多引擎实现。用纯 Node 实现：递归枚举
候选文件（遵守 glob 与默认排除目录）→ 逐文件读字节、按就近编码解码为 UTF-8 → 在 UTF-8 文本上
用 JS 正则/字笲串匹配。这避开了多平台 grep/rg 二进制依赖，且“搜 GB 中文”天然正确（先解码再匹配）。

**Files:**
- Create: `src/grep.ts`
- Test: `test/grep.test.ts`

**Interfaces:**
- Consumes: `resolveReadEncoding`（Task 5）；`decodeToUtf8`（Task 2）；`micromatch`；`node:fs`；TypeBox `Type`；Pi 类型 `ToolDefinition`, `ExtensionContext`, `AgentToolResult`（从 `@earendil-works/pi-coding-agent`）
- Produces:
  - `grepSchema` — TypeBox object: `{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }`
  - `type GrepInput = Static<typeof grepSchema>`
  - `searchFiles(rootAbs: string, input: GrepInput): Promise<string>` — 纯函数，返回格式化结果文本（`relpath:lineno:content`），便于单测
  - `createEncodingGrepDefinition(cwd: string): ToolDefinition<typeof grepSchema>` — name `"grep"`，包 `searchFiles`；不提供自定义渲染（用 Pi 默认文本渲染）

- [ ] **Step 1: 写失败测试**

```typescript
// test/grep.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { searchFiles } from "../src/grep";
import { clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "grep-"));
});

describe("searchFiles", () => {
  it("finds ASCII pattern in a UTF-8 file (no config, passthrough)", async () => {
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
    const out = await searchFiles(root, { pattern: "foo" });
    expect(out).toContain("a.txt");
    expect(out).toContain("foo bar");
  });

  it("finds Chinese pattern inside a GB18030 file via nearest config", async () => {
    writeFileSync(join(root, ".encoding-converter.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    writeFileSync(join(root, "cn.txt"), iconv.encode("第一行\n这里有标记内容\n末行\n", "GB18030"));
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).toContain("cn.txt");
    expect(out).toContain("这里有标记内容");
  });

  it("respects glob include filter", async () => {
    writeFileSync(join(root, "keep.py"), "needle\n", "utf-8");
    writeFileSync(join(root, "skip.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", glob: "*.py" });
    expect(out).toContain("keep.py");
    expect(out).not.toContain("skip.txt");
  });

  it("excludes node_modules and .git by default", async () => {
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, "top.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle" });
    expect(out).toContain("top.txt");
    expect(out).not.toContain(join("node_modules", "x.txt"));
  });

  it("literal mode treats pattern as fixed string", async () => {
    writeFileSync(join(root, "a.txt"), "a.b\naxb\n", "utf-8");
    const out = await searchFiles(root, { pattern: "a.b", literal: true });
    expect(out).toContain("a.b");
    expect(out).not.toContain("axb");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/grep.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 grep.ts 实现**

```typescript
// src/grep.ts
import { readdir, readFile as fsReadFile } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { resolveReadEncoding } from "./resolve";
import { decodeToUtf8 } from "./encoding/converter";

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regex (or literal when literal=true) pattern to search for" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: cwd)" })),
  glob: Type.Optional(Type.String({ description: "Glob to filter files, e.g. *.py" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
  context: Type.Optional(Type.Number({ description: "Lines of context before and after each match" })),
  limit: Type.Optional(Type.Number({ description: "Max total matches to return" })),
});

export type GrepInput = Static<typeof grepSchema>;

const EXCLUDE_DIRS = new Set([".git", ".svn", ".hg", "node_modules"]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
}

async function decodeFile(absPath: string): Promise<string> {
  const raw = await fsReadFile(absPath);
  const enc = await resolveReadEncoding(absPath);
  if (!enc || enc.toUpperCase() === "UTF-8") return raw.toString("utf-8");
  return decodeToUtf8(raw, enc);
}

export async function searchFiles(rootAbs: string, input: GrepInput): Promise<string> {
  const base = input.path ? path.resolve(rootAbs, input.path) : rootAbs;
  const files: string[] = [];
  await walk(base, files);

  const flags = input.ignoreCase ? "i" : "";
  const source = input.literal ? escapeRegex(input.pattern) : input.pattern;
  const re = new RegExp(source, flags);
  const ctx = input.context ?? 0;
  const limit = input.limit ?? 1000;

  const lines: string[] = [];
  let count = 0;

  for (const file of files) {
    if (input.glob) {
      const rel = path.relative(base, file).replace(/\\/g, "/");
      const isBare = !input.glob.includes("/");
      if (!micromatch.isMatch(rel, input.glob, isBare ? { matchBase: true } : undefined)) continue;
    }
    let text: string;
    try {
      text = await decodeFile(file);
    } catch {
      continue;
    }
    const fileLines = text.split("\n");
    const relFile = path.relative(rootAbs, file).replace(/\\/g, "/");
    for (let i = 0; i < fileLines.length; i++) {
      if (count >= limit) break;
      if (re.test(fileLines[i])) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(fileLines.length - 1, i + ctx);
        for (let j = start; j <= end; j++) {
          lines.push(`${relFile}:${j + 1}:${fileLines[j]}`);
        }
        count++;
      }
    }
    if (count >= limit) break;
  }

  if (lines.length === 0) return "No matches found.";
  return lines.join("\n");
}

export function createEncodingGrepDefinition(cwd: string): ToolDefinition<typeof grepSchema> {
  return {
    name: "grep",
    label: "grep (encoding aware)",
    description:
      "Search file contents by regex. Encoding-aware: transparently searches GB18030/GBK/GB2312 files, " +
      "including Chinese patterns. Excludes .git/node_modules by default.",
    parameters: grepSchema,
    async execute(
      _toolCallId: string,
      params: GrepInput,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<undefined>> {
      const text = await searchFiles(cwd, params);
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/grep.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add src/grep.ts test/grep.test.ts
git commit -m "feat(grep): encoding-aware grep matching built-in schema (G2)"
```

---

### Task 8: 扩展入口与集成（index.ts + README）

常驻注册四个同名覆盖工具；read/write/edit 用 Pi 工厂 + 注入 operations（不提供自定义渲染，继承内置 diff/高亮）；grep 用自实现 def。`session_start` 与 `resources_discover`(reload) 时清缓存。

**Files:**
- Create: `src/index.ts`
- Create: `README.md`
- Test: 无自动测试（集成入口）；用手动验证步骤代替。

**Interfaces:**
- Consumes: `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`（从 `@earendil-works/pi-coding-agent`，返回 `ToolDefinition`，可直接传给 `pi.registerTool`）；`makeReadOperations`, `makeWriteOperations`, `makeEditOperations`（Task 6）；`createEncodingGrepDefinition`（Task 7）；`clearConfigCache`（Task 4）；`ExtensionAPI`
- Produces: 默认导出的扩展工厂函数。

> 关键：`createXxxToolDefinition(cwd, { operations })` 返回的就是 `ToolDefinition`，名字已是
> `"read"`/`"write"`/`"edit"`，直接 `pi.registerTool(def)` 即可覆盖内置同名工具。不要传
> `renderCall`/`renderResult`，以继承内置渲染。

- [ ] **Step 1: 写 index.ts 实现**

```typescript
// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations } from "./operations";
import { createEncodingGrepDefinition } from "./grep";
import { clearConfigCache } from "./config";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Override built-in read/write/edit with encoding-aware operations.
  // No renderCall/renderResult -> inherit built-in rendering (diff/highlight/line numbers).
  pi.registerTool(createReadToolDefinition(cwd, { operations: makeReadOperations() }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: makeWriteOperations() }));
  pi.registerTool(createEditToolDefinition(cwd, { operations: makeEditOperations() }));

  // grep: self-implemented (built-in GrepOperations cannot search GB content).
  pi.registerTool(createEncodingGrepDefinition(cwd));

  // Config is cached per-directory; clear on session start and reload.
  pi.on("session_start", async () => {
    clearConfigCache();
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason === "reload") clearConfigCache();
  });
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过。若 `createXxxToolDefinition` 的注入 operations 类型不匹配，在此修正 Task 6 的返回类型标注。

- [ ] **Step 3: 写 README.md**

```markdown
# pi-encoding-fs

Encoding-aware `read` / `write` / `edit` / `grep` for [Pi](https://github.com/earendil-works).
Transparently handles GB18030 / GBK / GB2312 files while preserving Pi's native TUI
(diff view, syntax highlighting, line numbers).

## How it works

The extension registers tools with the same names as Pi's built-ins, overriding them.
`read`/`write`/`edit` reuse Pi's own tool skeletons via `createXxxToolDefinition`, injecting
encoding conversion only at the byte-IO layer, so Pi keeps computing and rendering diffs in
UTF-8. `grep` is self-implemented so it can search Chinese text inside GB-encoded files.

Encoding is decided **per file**: the extension walks up from the file's directory to the
nearest `.encoding-converter.json`. If none is found, it passes through as plain UTF-8
(identical to not having the extension installed).

## Configuration

Place `.encoding-converter.json` in any directory. It applies to files at or below it,
unless a deeper config overrides it.

```json
{
  "sourceEncoding": "GB18030",
  "confidenceThreshold": 0.8,
  "overrides": [
    { "pattern": "docs/**", "sourceEncoding": "UTF-8" },
    { "pattern": "legacy/**", "sourceEncoding": "GBK" }
  ]
}
```

- `sourceEncoding`: default encoding when detection is uncertain; also used for new files.
- `confidenceThreshold`: minimum chardet confidence (0-1) to trust auto-detection.
- `overrides`: glob rules relative to the config file's directory; most specific wins.

## Requirements

- Encoding detection uses Python + `chardet` when available. If Python is missing, the
  extension falls back to `sourceEncoding` from config.

## Install

\`\`\`bash
pi install <npm-or-git-target>
\`\`\`
```

- [ ] **Step 4: 手动验证（全量测试 + 真实 Pi 会话）**

Run: `npm test`
Expected: 全部单测通过（converter/line-endings/detector/config/resolve/operations/grep）。

手动（若本机有 pi）：在一个包含 `.encoding-converter.json`(sourceEncoding=GB18030) 的目录里，
用 `pi -e ./src/index.ts` 启动，让 agent read 一个 GB18030 中文文件 → 中文正常显示；
edit 一处 → diff 正常渲染且文件仍为 GB18030；grep 一个中文词 → 能命中。
Expected: 启动时 Pi 提示“内置工具被覆盖”警告；上述行为均正确。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: register encoding-aware tool overrides + docs"
```

---

## Self-Review 结果（作者自检）

- **Spec 覆盖**：方案 A（同名覆盖）=Task 8；diff 保留（不提供渲染）=Task 6+8；就近逐文件配置=Task 4+5；
  真透传=Task 5+6（返回 null 分支）；常驻 X1=Task 8；grep G2=Task 7；检测策略 3a=Task 2+3+5；
  行尾保持=Task 2+6；标准 Pi 包=Task 1。无遗漏。
- **占位符扫描**：无 TBD/TODO；每个代码步骤均含完整代码。
- **类型一致性**：`resolveReadEncoding`/`resolveWriteEncoding` 返回 `string | null` 贯穿 Task 5/6/7；
  `FoundConfig`/`EncodingConfig` 定义于 Task 4、被 Task 5 消费；`grepSchema` 定义于 Task 7。
- **待实现阶段验证**：`createXxxToolDefinition` 的 operations 注入类型、以及 `read` 返回
  “UTF-8 重编码 Buffer”是否被 Pi 正确按 UTF-8 解码 —— 在 Task 6 Step 5 / Task 8 Step 2/4 验证。

