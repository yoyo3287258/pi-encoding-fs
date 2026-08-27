// src/config.ts — schema v2（需求文档 §4），向后兼容上游 v1。
//
// 与上游的差异：
//  * 新增 writeEncoding / readStrategy / unmappable / verifyWrite / autoCandidates /
//    protectUtf8 / force；`confidenceThreshold` 保留解析但**不再使用**（旧的启发式
//    置信度打分器已删除，现在只有字节级确定性判定）。
//  * overrides 的规则键支持 v2 的 `encoding` 与 v1 的 `sourceEncoding`（后者兼容旧配置）。
//  * 允许 `.encoding-converter.json` 写注释（§4 的示例本身就是 jsonc）。
//  * 校验失败不再静默丢弃：错误与可疑配置会挂在 `FoundConfig.warnings` 上，
//    由 read 结果输出一行提示（把「以为生效其实没生效」变成可见信息）。
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";
import {
  UnsupportedEncodingError,
  isGBEncoding,
  isSingleByteEncoding,
  isStatefulEncoding,
  normalizeEncoding,
} from "./encoding/converter";
import { DEFAULT_AUTO_CANDIDATES } from "./encoding/classify";

export const CONFIG_FILENAME = ".encoding-converter.json";

export type ReadStrategy = "auto" | "config";
export type UnmappableStrategy = "error" | "escape" | "drop-to-gb18030";

export interface OverrideRule {
  pattern: string;
  /** schema v2 */
  encoding?: string;
  /** schema v1（上游用的键名） */
  sourceEncoding?: string;
  writeEncoding?: string;
  /** 跳过字节判定，严格按本规则的 encoding 读写（单字节编码只能这样用，性质 P-6） */
  force?: boolean;
  readStrategy?: ReadStrategy;
  unmappable?: UnmappableStrategy;
  autoCandidates?: string[];
  protectUtf8?: boolean;
  verifyWrite?: boolean;
}

export interface EncodingConfig {
  sourceEncoding: string;
  writeEncoding?: string;
  readStrategy?: ReadStrategy;
  unmappable?: UnmappableStrategy;
  verifyWrite?: boolean;
  protectUtf8?: boolean;
  autoCandidates?: string[];
  /** §4：保留解析、忽略使用（不让上游已有配置报错） */
  confidenceThreshold?: number;
  /** P5 预留，本轮不实现 */
  transcodeBash?: boolean;
  overrides?: OverrideRule[];
}

/** 目录级缓存的条目：连同 config 的 mtime/size 一起存，配置文件被改了就重读（T-14）。 */
interface CacheEntry {
  config: EncodingConfig;
  warnings: string[];
  mtimeMs: number;
  size: number;
}

export interface FoundConfig {
  config: EncodingConfig;
  configDir: string;
  /** 解析/校验期间的非致命问题（未知编码名、单字节编码未 force、readStrategy 冲突等） */
  warnings?: string[];
}

/** 合并「就近配置 + 最特异 override」之后、针对单个文件的完整决策上下文（§3.1 的 cfg 入参）。 */
export interface ResolvedConfig {
  configDir: string;
  sourceEncoding: string;
  writeEncoding: string;
  readStrategy: ReadStrategy;
  unmappable: UnmappableStrategy;
  verifyWrite: boolean;
  protectUtf8: boolean;
  autoCandidates: string[];
  force: boolean;
  /** 命中的 override pattern（诊断用） */
  matchedPattern: string | null;
  warnings: string[];
}

interface ConfigDefaults {
  sourceEncoding: string;
  readStrategy: ReadStrategy;
  unmappable: UnmappableStrategy;
  verifyWrite: boolean;
  protectUtf8: boolean;
  autoCandidates: string[];
  confidenceThreshold: number;
  transcodeBash: boolean;
}

const DEFAULTS: ConfigDefaults = {
  sourceEncoding: "GB18030",
  readStrategy: "auto",
  unmappable: "error",
  verifyWrite: true,
  protectUtf8: true,
  autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
  confidenceThreshold: 0.8,
  transcodeBash: false,
};

// dir -> 已检查（可能为 null = 这层没有配置）
const dirCache = new Map<string, CacheEntry | null>();

export function clearConfigCache(): void {
  dirCache.clear();
}

/** 容忍 `//` 行注释与 `/* *\/` 块注释（不吞字符串字面量里的内容）。 */
export function stripJsonComments(src: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function validateConfig(parsed: Record<string, unknown>, where: string): { config: EncodingConfig; warnings: string[] } {
  const warnings: string[] = [];
  const merged = { ...DEFAULTS, ...(parsed ?? {}) } as EncodingConfig;
  try {
    merged.sourceEncoding = normalizeEncoding(String(merged.sourceEncoding ?? "GB18030"));
  } catch (e) {
    warnings.push(`${where}: sourceEncoding "${merged.sourceEncoding}" 不可用（${(e as Error).message}）→ 按 GB18030 处理`);
    merged.sourceEncoding = "GB18030";
  }
  if (merged.writeEncoding) {
    try {
      merged.writeEncoding = normalizeEncoding(String(merged.writeEncoding));
    } catch (e) {
      warnings.push(`${where}: writeEncoding "${merged.writeEncoding}" 不可用 → 回退 sourceEncoding`);
      merged.writeEncoding = merged.sourceEncoding;
    }
  }
  if (merged.readStrategy !== "auto" && merged.readStrategy !== "config") {
    warnings.push(`${where}: readStrategy "${merged.readStrategy}" 非法 → 用 "auto"`);
    merged.readStrategy = "auto";
  }
  if (merged.unmappable !== "error" && merged.unmappable !== "escape" && merged.unmappable !== "drop-to-gb18030") {
    warnings.push(`${where}: unmappable "${merged.unmappable}" 非法 → 用 "error"`);
    merged.unmappable = "error";
  }
  if (typeof merged.verifyWrite !== "boolean") merged.verifyWrite = true;
  if (typeof merged.protectUtf8 !== "boolean") merged.protectUtf8 = true;
  if (!Array.isArray(merged.autoCandidates) || merged.autoCandidates.length === 0) {
    merged.autoCandidates = [...DEFAULT_AUTO_CANDIDATES];
  } else {
    const kept: string[] = [];
    for (const c of merged.autoCandidates) {
      let n: string;
      try {
        n = normalizeEncoding(String(c));
      } catch {
        warnings.push(`${where}: autoCandidates 里的 "${c}" 不是可用编码，已忽略（自动判定只支持 ${DEFAULT_AUTO_CANDIDATES.join("/")}）`);
        continue;
      }
      if (isSingleByteEncoding(n) || isStatefulEncoding(n)) {
        warnings.push(
          `${where}: autoCandidates 不允许包含 "${n}"（单字节/转义序列编码对任意字节都能无损回环，性质 P-6）—— 只能在 overrides 里用 "force": true 指定`,
        );
        continue;
      }
      kept.push(n);
    }
    if (kept.length === 0) {
      warnings.push(`${where}: autoCandidates 全部无效 → 回退默认候选链`);
      merged.autoCandidates = [...DEFAULT_AUTO_CANDIDATES];
    } else merged.autoCandidates = kept;
  }
  if (parsed.confidenceThreshold === undefined) merged.confidenceThreshold = DEFAULTS.confidenceThreshold;
  if (merged.overrides) {
    merged.overrides = merged.overrides.map((r) => {
      const rule: OverrideRule = { ...r };
      const label = r.encoding ?? r.sourceEncoding;
      if (!label) {
        warnings.push(`${where}: override "${r.pattern}" 缺少 encoding/sourceEncoding，已忽略`);
        return rule;
      }
      try {
        const n = normalizeEncoding(String(label));
        if (r.encoding !== undefined) rule.encoding = n;
        else rule.sourceEncoding = n;
        if ((isSingleByteEncoding(n) || isStatefulEncoding(n)) && rule.force !== true) {
          warnings.push(
            `${where}: override "${r.pattern}" 的 ${n} 在字节层无法判定，需要 "force": true 才会生效（性质 P-6 / §7）`,
          );
        }
      } catch (e) {
        warnings.push(`${where}: override "${r.pattern}" 的编码 "${label}" 不可用（${(e as UnsupportedEncodingError).message}）`);
      }
      if (rule.writeEncoding) {
        try {
          rule.writeEncoding = normalizeEncoding(rule.writeEncoding);
        } catch {
          warnings.push(`${where}: override "${r.pattern}" 的 writeEncoding 不可用，已回退`);
          rule.writeEncoding = undefined;
        }
      }
      return rule;
    });
  }
  return { config: merged, warnings };
}

async function loadConfigInDir(dir: string): Promise<CacheEntry | null> {
  const cached = dirCache.get(dir);
  const p = path.join(dir, CONFIG_FILENAME);
  let st;
  try {
    st = await stat(p);
  } catch {
    dirCache.set(dir, null);
    return null;
  }
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let text: string;
  try {
    text = await readFile(p, "utf-8");
  } catch {
    dirCache.set(dir, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    // 语法错误：明确记 warning，但仍把「这里存在配置」当真——否则用户改坏配置后扩展静默退回透传。
    const entry: CacheEntry = {
      config: { ...DEFAULTS },
      warnings: [`${p} 不是合法 JSON（${(e as Error).message}）；本次按默认值处理，请修正该文件`],
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    dirCache.set(dir, entry);
    return entry;
  }
  const { config, warnings } = validateConfig((parsed ?? {}) as Record<string, unknown>, p);
  const entry: CacheEntry = { config, warnings, mtimeMs: st.mtimeMs, size: st.size };
  dirCache.set(dir, entry);
  return entry;
}

export async function findNearestConfig(startDir: string): Promise<FoundConfig | null> {
  let cur = path.resolve(startDir);
  const warnings: string[] = [];
  while (true) {
    const entry = await loadConfigInDir(cur);
    if (entry) {
      if (entry.warnings.length) warnings.push(...entry.warnings);
      return { config: entry.config, configDir: cur, warnings };
    }    const parent = path.dirname(cur);
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

function ruleMatches(rel: string, pattern: string): boolean {
  if (!pattern) return false;
  const isBare = !pattern.includes("/");
  return micromatch.isMatch(rel, pattern, isBare ? { matchBase: true } : undefined);
}

function pickOverride(absFilePath: string, found: FoundConfig): { rule: OverrideRule | null; score: number } {
  const { config, configDir } = found;
  if (!config.overrides?.length) return { rule: null, score: 0 };
  const rel = path.relative(configDir, absFilePath).replace(/\\/g, "/");
  const matched = config.overrides
    .map((rule, index) => ({ rule, score: scoreSpecificity(rule.pattern), index }))
    .filter((it) => ruleMatches(rel, it.rule.pattern))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = matched[0];
  return best ? { rule: best.rule, score: best.score } : { rule: null, score: 0 };
}

/**
 * 单个文件的完整决策上下文：config 默认值 ← 最特异 override（逐字段覆盖）。
 * 同时把「GB 系写 UTF-8 之外」的常见误配在这里合成一次，下游不再各自判断。
 */
export function resolveFileRule(absFilePath: string, found: FoundConfig): ResolvedConfig {
  const { config, configDir } = found;
  const { rule } = pickOverride(absFilePath, found);
  const warnings = [...(found.warnings ?? [])];
  const overrideRead = normalizeRuleLabel(rule?.encoding ?? rule?.sourceEncoding);
  const sourceEncoding = overrideRead ?? config.sourceEncoding;
  const rootWrite = normalizeRuleLabel(config.writeEncoding);
  const rootSource = normalizeRuleLabel(config.sourceEncoding);
  // “根配置有迁移意图” := 根同时写了 writeEncoding 且与 sourceEncoding 不同。
  const migrationIntent = !!rootWrite && !!rootSource && rootWrite !== rootSource;
  // override 只写 encoding 且根无迁移意图 → 写目标跟着该 override（“这个目录是 UTF-8”
  // 的自然语义包含“新文件/纯 ASCII 文件也按 UTF-8 写”）；根有迁移意图时根赢，避免默默推翻迁移。
  const writeEncoding =
    normalizeRuleLabel(rule?.writeEncoding) ??
    (overrideRead && !migrationIntent ? overrideRead : rootWrite ?? sourceEncoding);
  if (migrationIntent && overrideRead && rootWrite && overrideRead !== rootWrite && !rule?.writeEncoding) {
    warnings.push(
      `${configDir}: 根配置带迁移意图（sourceEncoding=${rootSource} → writeEncoding=${rootWrite}），` +
        `而 override "${rule?.pattern}" 只声明了读编码 ${overrideRead} → 该目录里**新建/纯 ASCII** 文件仍按 ${rootWrite} 写。` +
        `要让它们也用 ${overrideRead}，请在那条 override 里显式加 "writeEncoding": "${overrideRead}"。`,
    );
  }
  if (rule?.writeEncoding && rule.encoding === undefined && rule.sourceEncoding === undefined) {
    warnings.push(`${configDir}: override "${rule.pattern}" 只写了 writeEncoding，读编码沿用 ${sourceEncoding}`);
  }
  const force = rule?.force ?? false;
  if (isGBEncoding(writeEncoding) && isGBEncoding(sourceEncoding) && writeEncoding !== sourceEncoding) {
    // 只对 GB 家族提示这个坑（P-4：GB18030 写既有 GBK 内容逐字节不变，反过来则不成立）
    if (writeEncoding.toUpperCase() === "GBK" && sourceEncoding.toUpperCase() === "GB18030") {
      warnings.push(
        `${configDir}: writeEncoding=GBK 而 sourceEncoding=GB18030 —— 已存在的 4 字节扩展区字符会在写出时被闸门 1 拒绝（建议 writeEncoding 也用 GB18030）`,
      );
    }
  }
  return {
    configDir,
    sourceEncoding,
    writeEncoding,
    readStrategy: rule?.readStrategy ?? config.readStrategy ?? DEFAULTS.readStrategy,
    unmappable: rule?.unmappable ?? config.unmappable ?? DEFAULTS.unmappable,
    verifyWrite: rule?.verifyWrite ?? config.verifyWrite ?? DEFAULTS.verifyWrite,
    protectUtf8: rule?.protectUtf8 ?? config.protectUtf8 ?? DEFAULTS.protectUtf8,
    autoCandidates: rule?.autoCandidates?.length
      ? (rule.autoCandidates.map((c) => safeNormalize(String(c))).filter(Boolean) as string[])
      : config.autoCandidates ?? DEFAULTS.autoCandidates,
    force,
    matchedPattern: rule?.pattern ?? null,
    warnings,
  };
}

function safeNormalize(label: string): string | null {
  try {
    return normalizeEncoding(label);
  } catch {
    return null;
  }
}

function normalizeRuleLabel(label: string | undefined): string | null {
  if (!label) return null;
  const n = safeNormalize(label);
  return n ?? null;
}

/** v1 API：只回读编码（grep / 旧测试用）。新代码请用 resolveFileRule + classify。 */
export function resolveOverrideEncoding(absFilePath: string, found: FoundConfig): string {
  return resolveFileRule(absFilePath, found).sourceEncoding;
}
