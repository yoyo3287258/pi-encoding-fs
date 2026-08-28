// src/grep.ts — §5.1：不再污染非 GBK 项目
//
// 三条硬要求（§5.1）：
//  1. **找不到配置的目录树 → 整体委托 pi 内置 grep**（§8 A-1：无配置目录行为逐字节一致）。
//  2. 自实现路径补齐 `--hidden`，不加 `--no-ignore`（.gitignore 行为与内置一致），
//     输出/limit/截断语义对齐 `core/tools/grep.js` + `truncate.js`，直接复用公开导出的
//     `truncateHead/truncateLine/formatSize/DEFAULT_MAX_BYTES`。
//  3. rg 定位要命中 pi 自带的 `~/.pi/agent/bin/rg(.exe)`（上游只看 PATH 与 @vscode/ripgrep）。
//
// 与上游分组逻辑的差异（P3 定稿）：
//  上游按 override 的**目录前缀**划分搜索范围，并在默认组里排除这些目录。OAWSSMS 的实测画像
//  证明这不够：同一目录里 GBK 与 UTF-8 文件混住（.java: GBK 3069 + 合法 UTF-8 45），目录级
//  分组会漏搜/错搜。现在改成「多趟搜索 + **逐文件字节判定过滤**」：每趟用一种编码，命中后用
//  classifyBuffer 确认「这个文件用 read 打开时确实是那个编码」才保留 —— 既不会把 UTF-8 文件
//  按 GBK 误命中，也不会重复计数。`buildEncodingGroups()` 保留，用于收集编码集合。
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { findNearestConfig, resolveFileRule, type FoundConfig } from "./config";
import { classifyFileCached } from "./encoding/classify";
import { isSingleByteEncoding, normalizeEncoding, decodeToUtf8 } from "./encoding/converter";

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

/** 与内置一致：这些目录永远不搜（.svn 对 SVN 工程是必须的 —— 里面有每份文件的 pristine 副本） */
const DEFAULT_EXCLUDE_DIRS = [".git", ".svn", ".hg", "node_modules"];

/** pi 内置的 limit 默认值与截断口径（core/tools/grep.js） */
const DEFAULT_LIMIT = 100;
/** pi 内置 grep 的单行截断长度（GREP_MAX_LINE_LENGTH 未公开导出，此处为其实测值） */
const GREP_MAX_LINE_LENGTH = 500;

// ── ripgrep discovery (cached) ───────────────────────────────────────

let _rgCache: string | null | undefined;

function tryRg(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/** pi 自己的工具目录（`~/.pi/agent/bin/rg.exe`）—— pi 的 ensureTool 优先用的就是这里 */
function piAgentRg(): string | null {
  const bin = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (!existsSync(bin)) return null;
  try {
    accessSync(bin, constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

function findRgFromVscode(): string | null {
  const dirs = ["@vscode/ripgrep"];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm", "node_modules", "@vscode", "ripgrep"));
  dirs.push(path.join(path.dirname(process.execPath), "node_modules", "@vscode", "ripgrep"));
  for (const dir of dirs) {
    try {
      const { rgPath } = require(dir);
      if (rgPath) {
        accessSync(rgPath, constants.X_OK);
        return rgPath;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/** Locate the ripgrep binary, or null if unavailable. Cached across calls. */
export function findRg(): string | null {
  if (_rgCache !== undefined) return _rgCache;
  _rgCache = piAgentRg() ?? (tryRg("rg") ? "rg" : findRgFromVscode());
  return _rgCache;
}

/** Reset the cached rg lookup (used in tests). */
export function resetRgCache(): void {
  _rgCache = undefined;
}

// ── Encoding grouping from nearest config ────────────────────────────

/**
 * Extract the directory prefix of a glob pattern (the part before the first
 * glob metacharacter). "openspec/**" → "openspec", "legacy/*.c" → "legacy",
 * "*.py" → ".".
 */
export function globDirPrefix(pattern: string): string {
  const idxs = [pattern.indexOf("*"), pattern.indexOf("?"), pattern.indexOf("[")].filter((i) => i >= 0);
  const idx = idxs.length ? Math.min(...idxs) : -1;
  const dirPart = idx === -1 ? pattern : pattern.slice(0, idx);
  const lastSlash = dirPart.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  return dirPart.slice(0, lastSlash) || ".";
}

export interface EncodingGroup {
  encoding: string;
  /** Directories (relative to configDir) this group searches. Empty = whole tree. */
  includeDirs: string[];
  /** Directories (relative to configDir) to exclude (default group only). */
  excludeDirs: string[];
}

/**
 * Split search into per-encoding groups based on config overrides.
 *
 * - The default group uses `sourceEncoding` and searches the whole tree, minus
 *   any override directories (so override files aren't searched with the wrong
 *   encoding or double-counted).
 * - Each override whose encoding differs from the default becomes its own group,
 *   searching just that override's directory prefix.
 *
 * P3 起 `searchFiles` 只用它取**编码集合**（`group.encoding`）；目录字段保留给
 * 诊断与向后兼容，真正的去重/防误命中由逐文件判定承担。
 */
export function buildEncodingGroups(found: FoundConfig): EncodingGroup[] {
  const { config } = found;
  const defaultEncoding = config.sourceEncoding;
  const overrideGroups = new Map<string, Set<string>>();
  const excludeDirs = new Set<string>();

  for (const ov of config.overrides ?? []) {
    const enc = ov.encoding ?? ov.sourceEncoding ?? defaultEncoding; // v2 用 encoding，v1 用 sourceEncoding
    if (enc === defaultEncoding) continue;
    const dir = globDirPrefix(ov.pattern);
    if (dir === ".") continue; // root-level override can't be isolated by dir
    excludeDirs.add(dir);
    if (!overrideGroups.has(enc)) overrideGroups.set(enc, new Set());
    overrideGroups.get(enc)!.add(dir);
  }

  const groups: EncodingGroup[] = [
    { encoding: defaultEncoding, includeDirs: [], excludeDirs: [...excludeDirs].sort() },
  ];
  for (const [encoding, dirs] of overrideGroups) {
    groups.push({ encoding, includeDirs: [...dirs].sort(), excludeDirs: [] });
  }
  return groups;
}

/** GBK/GB2312 的码位与 GB18030 完全相同（P-4：GB18030 是严格超集），所以一趟 GB18030 就够 */
const GB_SUPERSET = "GB18030";
const GB_FAMILY = new Set(["GBK", "GB2312", "GB_2312", "HZ-GB-2312", "CP936", "WINDOWS-936"]);

/**
 * 要跑几趟搜索。规则：
 *  - 永远先跑 UTF-8（不传 --encoding，顺带靠 rg 的 BOM 嗅探处理带 BOM 的 UTF-16）；
 *  - **纯 ASCII pattern 不需要其它趟**（任何 ASCII 兼容编码下字节相同）；
 *  - 其余编码取自配置的读侧（sourceEncoding / autoCandidates / override 声明），
 *    单字节编码跳过（它们装不下中文，ASCII 部分已由 UTF-8 趟覆盖 —— 性质 P-6）；
 *  - GB 家族折叠成 GB18030 一趟。
 */
export function buildEncodingPasses(found: FoundConfig | null, pattern: string): string[] {
  const passes = ["UTF-8"];
  if (!found || /[^\x00-\x7f]/.test(pattern) === false) return passes;
  const { config } = found;
  const declared = new Set<string>();
  const add = (name: string | undefined | null) => {
    if (!name) return;
    let n: string | null = null;
    try {
      n = normalizeEncoding(name);
    } catch {
      n = null;
    }
    if (!n) return;
    if (n.toUpperCase() === "UTF-8") return;
    if (isSingleByteEncoding(n)) return; // 单字节编码不可能含中文
    declared.add(n.toUpperCase());
  };
  add(config.sourceEncoding);
  add(config.writeEncoding);
  for (const c of config.autoCandidates ?? []) add(c);
  for (const ov of config.overrides ?? []) {
    add(ov.encoding ?? ov.sourceEncoding);
    add(ov.writeEncoding);
    for (const c of ov.autoCandidates ?? []) add(c);
  }
  const hasSuperset = declared.has(GB_SUPERSET);
  for (const enc of [...declared].sort()) {
    if (hasSuperset && GB_FAMILY.has(enc)) continue; // GB18030 已覆盖
    passes.push(enc);
  }
  return passes;
}

/** WHATWG encoding label for ripgrep's --encoding. UTF-8 uses rg's default (no flag). */
function rgEncodingLabel(encoding: string): string | null {
  const up = encoding.toUpperCase();
  if (up === "UTF-8" || up === "UTF8") return null; // rg 默认（且会嗅探 BOM/UTF-16）
  return encoding.toLowerCase(); // gb18030 / gbk / gb2312 / big5 都是合法 WHATWG label
}

interface RawMatch {
  file: string;
  line: number;
  text: string | undefined;
  encoding: string;
}

function buildRgArgs(input: GrepInput, encoding: string, searchPath: string): string[] {
  // 与内置一致：--json --line-number --color=never --hidden（内置就是这么拼的）
  const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
  const enc = rgEncodingLabel(encoding);
  if (enc) args.push("--encoding", enc);
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.glob) args.push("--glob", input.glob);
  // 永远排除 VCS 镜像目录与 node_modules（rg 的 --hidden 会连 .git/.svn 一起搜，实测确认）
  for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--glob", `!**/${d}/**`);
  args.push("--", input.pattern, searchPath);
  return args;
}

/** 与内置 GrepToolDetails 同构（那个类型未从包根导出，这里用结构化定义保证渲染器可直接复用） */
export interface GrepDetails {
  truncation?: ReturnType<typeof truncateHead>;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  /** 诊断：本次实际跑了哪几趟编码 / 哪些趟报错被跳过（P3 的 UI 通知用，不进模型上下文） */
  searchedWith?: string[];
  skippedPasses?: string[];
}

function runRgPass(
  rg: string,
  args: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: RawMatch[]; error: string | null; hitLimit: boolean }> {
  return new Promise((resolve) => {
    const matches: RawMatch[] = [];
    let stderr = "";
    let hitLimit = false;
    let settled = false;
    const done = (error: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ matches, error, hitLimit });
    };
    const child = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== "match") continue;
        matches.push({
          file: ev.data?.path?.text ?? "",
          line: ev.data?.line_number as number,
          text: ev.data?.lines?.text,
          encoding: "",
        });
        if (matches.length >= limit) {
          hitLimit = true;
          child.kill();
          done(null);
          return;
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => done(e.message));
    child.on("close", (code) => {
      // rg: 0 = 命中, 1 = 无命中, 其它 = 出错（编码名不合法等）。出错时保留已收集的命中。
      const ok = code === 0 || code === 1 || hitLimit;
      done(ok ? null : stderr.trim() || `rg exited with code ${code}`);
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

/** 逐文件判定需要的编码上下文（与 read 链路同一份规则） */
function ruleContextFor(abs: string, found: FoundConfig) {
  const rule = resolveFileRule(abs, found);
  return {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  };
}

/** 该文件的判定编码与这一趟用的编码是否同一解码（GB 家族码位相同，P-4） */
function sameDecodeFamily(vEncoding: string, passEncoding: string): boolean {
  const a = normalizeEncoding(vEncoding);
  const b = normalizeEncoding(passEncoding);
  if (!a || !b) return false;
  const up = (x: string) => x.toUpperCase();
  if (up(a) === up(b)) return true;
  return (up(a) === GB_SUPERSET && GB_FAMILY.has(up(b))) || (up(b) === GB_SUPERSET && GB_FAMILY.has(up(a)));
}

export interface SearchResult {
  text: string;
  details: GrepDetails;
  searchedWith: string[];
  skippedPasses: string[];
}

/**
 * 编码感知的搜索。返回 null 表示"这里没有配置 / rg 不可用"，调用方**整体委托内置 grep**。
 */
export async function searchFiles(rootAbs: string, input: GrepInput, signal?: AbortSignal): Promise<SearchResult | null> {
  const rg = findRg();
  if (!rg) return null;

  const searchPath = path.resolve(rootAbs, input.path || ".");
  let isDir = true;
  try {
    isDir = statSync(searchPath).isDirectory();
  } catch {
    return null; // 路径不存在 → 交给内置去报它自己的错
  }
  const found = await findNearestConfig(isDir ? searchPath : path.dirname(searchPath));
  if (!found) return null; // §5.1 要求 1：无配置目录整体委托内置（A-1）

  const passes = buildEncodingPasses(found, input.pattern);
  const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const collected: RawMatch[] = [];
  const seen = new Set<string>();
  const used: string[] = [];
  const skipped: string[] = [];

  // 逐文件解码链（与 read 工具用同一套判定 + 解码），既给可信度复核用，也给上下文行用
  const lineCache = new Map<string, string[]>();
  const linesOf = (abs: string): string[] => {
    let hit = lineCache.get(abs);
    if (!hit) {
      const v = classifyFileCached(abs, ruleContextFor(abs, found));
      const text = v.kind === "binary" || v.kind === "unknown" ? "" : decodeWith(v.encoding, abs);
      hit = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      lineCache.set(abs, hit);
    }
    return hit;
  };
  const regexCache = new Map<string, RegExp | null>();
  const patternHitsLine = (line: string): boolean => {
    if (input.literal) {
      return input.ignoreCase
        ? line.toLowerCase().includes(input.pattern.toLowerCase())
        : line.includes(input.pattern);
    }
    const key = input.ignoreCase ? "i" : "";
    let re = regexCache.get(key);
    if (re === undefined) {
      try {
        re = new RegExp(input.pattern, key);
      } catch {
        re = null; // Rust regex 语法 JS 不支持 → 不做语义否决，信这一趟
      }
      regexCache.set(key, re);
    }
    return re === null ? true : re.test(line);
  };
  /**
   * 命中可信度：不能只看“哪一趟搜到的”。
   * ① ASCII pattern 在任何编码下字节相同，UTF-8 趟本来就能搜到 GBK 文件的 needle 行；
   * ② 反过来，UTF-8 文件的字节被 GBK 趟解成乱码时也会“假命中”（乱码词恰好拼上）。
   * 所以编码同名直接信任；不同名时用**该文件自己 read 时看到的行文本**做语义复核。
   */
  const trusted = (abs: string, m: RawMatch): boolean => {
    const v = classifyFileCached(abs, ruleContextFor(abs, found));
    if (v.kind === "binary" || v.kind === "unknown") return false;
    if (v.kind === "ascii" || sameDecodeFamily(v.encoding, m.encoding)) return true;
    const line = linesOf(abs)[m.line - 1];
    return line !== undefined && patternHitsLine(line.replace(/\r/g, ""));
  };

  for (const enc of passes) {
    const remaining = effectiveLimit - collected.length;
    if (remaining <= 0) break;
    const { matches, error } = await runRgPass(rg, buildRgArgs(input, enc, searchPath), remaining, signal);
    if (error) {
      skipped.push(`${enc}（${error.slice(0, 60)}）`);
      continue;
    }
    used.push(enc);
    for (const m of matches) {
      if (!m.file || typeof m.line !== "number") continue;
      const abs = path.resolve(searchPath, m.file);
      const key = `${abs}:${m.line}`;
      if (seen.has(key)) continue; // 多趟之间的重复计数
      seen.add(key);
      m.encoding = enc;
      if (!trusted(abs, m)) continue; // 乱码拼上的假命中丢掉
      collected.push({ ...m, file: abs });
    }
  }

  return formatLikeBuiltin(searchPath, collected, effectiveLimit, input, used, skipped, linesOf);
}

/** 输出格式与内置 grep 逐点对齐（路径风格、context 块、截断提示语、details 形状） */
function formatLikeBuiltin(
  searchPath: string,
  matches: RawMatch[],
  effectiveLimit: number,
  input: GrepInput,
  used: string[],
  skipped: string[],
  readLines: (abs: string) => string[],
): SearchResult {
  const details: SearchResult["details"] = {};
  if (matches.length === 0) {
    return {
      text: "No matches found", // 内置文案（无句号）
      details,
      searchedWith: used,
      skippedPasses: skipped,
    };
  }
  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line); // 本扩展额外保证确定性（内置不保证）
  const isDir = (() => {
    try {
      return statSync(searchPath).isDirectory();
    } catch {
      return false;
    }
  })();
  const formatPath = (f: string) => {
    if (isDir) {
      const rel = path.relative(searchPath, f);
      if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
    }
    return path.basename(f);
  };
  const contextValue = input.context && input.context > 0 ? input.context : 0;
  let linesTruncated = false;
  const outputLines: string[] = [];
  for (const m of matches) {
    const rel = formatPath(m.file);
    if (contextValue === 0 && m.text !== undefined) {
      const sanitized = m.text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text: t, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${rel}:${m.line}: ${t}`);
      continue;
    }
    const lines = readLines(m.file);
    if (!lines.length) {
      outputLines.push(`${rel}:${m.line}: (unable to read file)`);
      continue;
    }
    const start = Math.max(1, m.line - contextValue);
    const end = Math.min(lines.length, m.line + contextValue);
    for (let cur = start; cur <= end; cur++) {
      const sanitized = (lines[cur - 1] ?? "").replace(/\r/g, "");
      const { text: t, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(cur === m.line ? `${rel}:${cur}: ${t}` : `${rel}-${cur}- ${t}`);
    }
  }
  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (matches.length >= effectiveLimit) {
    notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return { text: output, details, searchedWith: used, skippedPasses: skipped };
}

function decodeWith(encoding: string, abs: string): string {
  // 复用 read 链路的解码实现，避免第二套语义
  return decodeToUtf8(readFileSync(abs), encoding);
}

// ── Tool definition ──────────────────────────────────────────────────

export function createEncodingGrepDefinition(cwd: string): ToolDefinition<typeof grepSchema, GrepDetails> {
  // 内置 def 有三个用途：① 无配置目录 / rg 不可用时整体委托；② 复用它的渲染器（UI 上的截断
  // 提示、展开行为一字不差）；③ 复用它的 description。details 类型与内置同构（那个类型未从
  // 包根导出），所以这里做一次受控 cast，而不是拷贝一份内置实现。
  const builtin = createGrepToolDefinition(cwd) as unknown as ToolDefinition<typeof grepSchema, GrepDetails>;

  return {
    name: "grep",
    label: "grep (encoding aware)",
    description: builtin.description,
    promptSnippet: "Search file contents for patterns (respects .gitignore; encoding-aware where a config exists)",
    parameters: grepSchema,
    async execute(
      toolCallId: string,
      params: GrepInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof builtin.execute>[3],
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<GrepDetails>> {
      const res = await searchFiles(cwd, params, signal);
      if (!res) {
        // 无配置目录 or 没有 rg → 与未装本扩展逐字节一致
        return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      return {
        content: [{ type: "text", text: res.text }],
        details: { ...res.details, searchedWith: res.searchedWith, skippedPasses: res.skippedPasses },
      };
    },
    renderCall: builtin.renderCall,
    renderResult: builtin.renderResult,
  };
}
