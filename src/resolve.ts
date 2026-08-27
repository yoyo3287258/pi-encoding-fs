// src/resolve.ts — 编码决策层（§3.1 读判定 + §3.2 写矩阵）。
// 这里只产出「计划」，不碰磁盘；磁盘 IO 与三道闸门在 operations.ts。
import { readFile, access } from "node:fs/promises";
import * as path from "node:path";
import { findNearestConfig, resolveFileRule, type ResolvedConfig } from "./config";
import { classifyBuffer, describeVerdict, exactRoundTrip, type Kind, type Verdict } from "./encoding/classify";
import { isGBEncoding, normalizeEncoding } from "./encoding/converter";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readRawOrNull(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

/** 就近配置 → 该文件的决策上下文；无配置返回 null（= 一切透传，§4 的根基）。 */
export async function ruleFor(absFilePath: string): Promise<ResolvedConfig | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;
  return resolveFileRule(absFilePath, found);
}

// ── 读计划 ─────────────────────────────────────────────────────────────────

export interface ReadPlan {
  /** 是否需要把磁盘字节解成 UTF-8（false = 原样透传） */
  transcoded: boolean;
  /** 读侧解码编码 */
  encoding: string;
  kind: Kind;
  verdict: Verdict;
  rule: ResolvedConfig;
  /** 需要追加到 read 结果尾部的一行警告（null = 不加） */
  note: string | null;
}

export async function resolveReadPlan(absFilePath: string): Promise<ReadPlan | null> {
  const rule = await ruleFor(absFilePath);
  if (!rule) return null; // 无配置 → 完全透传（A-1）
  const raw = await readRawOrNull(absFilePath);
  if (raw === null) {
    return {
      transcoded: false,
      encoding: rule.sourceEncoding,
      kind: "utf8",
      verdict: classifyBuffer(Buffer.alloc(0), rule),
      rule,
      note: null,
    };
  }
  const verdict = classifyBuffer(raw, {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  });
  const warnings = [...rule.warnings];

  // readStrategy:"config" 只改变「显示用什么编码解」；写侧仍按 classify 决定，
  // 因此它与磁盘实况冲突时会由闸门 3 拒绝写入（T-15 的可控行为，而不是崩溃）。
  let readEncoding = verdict.encoding;
  let transcodedKind: Kind = verdict.kind;
  if (rule.readStrategy === "config" && verdict.kind !== "binary") {
    if (normalizeEncoding(rule.sourceEncoding) !== verdict.encoding) {
      readEncoding = normalizeEncoding(rule.sourceEncoding);
      transcodedKind = "config";
      warnings.push(
        `readStrategy="config"：字节判定为 ${describeVerdict(verdict)}，但按配置强制用 ${readEncoding} 解码（仅影响显示；写回仍由判定决定）`,
      );
    }
  }

  let note: string | null = null;
  // 关键约束：警告行只能追加到「写入本来就会被拒」的文件上。pi 的 edit 把 readFile 的
  // 文本当基线内容写回，在这类文件上追加普通提示会被下一次 edit 当成文件内容写进磁盘（污染）。
  // 因此只在下两种情况下注 note（它们对应的写入均会被闸门 3 拒绝），其余提示走
  // plan.warnings → 系统提示注入 / UI 通知（§5.2 / P3）。
  if (verdict.kind === "unknown") {
    note = `[encoding: UNKNOWN — 未转码，写入将被拒绝] 判定失败的路径=${absFilePath}`;
  } else if (verdict.kind === "config" && verdict.configReason === "force" && verdict.hasFffd) {
    note =
      `[encoding: ${verdict.encoding} 按 force 解码出现 U+FFFD —— 配置与文件真实编码不符，写入将被拒绝] 路径=${absFilePath}`;
  }

  return {
    transcoded: readEncoding !== "UTF-8" && verdict.kind !== "binary" && verdict.kind !== "unknown",
    encoding: readEncoding,
    kind: transcodedKind,
    verdict,
    rule,
    note,
  };
}

// ── 写计划（§3.2 决策矩阵 + 闸门 3 的拒绝点） ───────────────────────────────

export interface WritePlan {
  /** null = 无配置，完全透传（行为与未装扩展逐字节一致） */
  encoding: string | null;
  rule: ResolvedConfig | null;
  kind: Kind | "new";
  verdict: Verdict | null;
  /** 写出时需要在字节层补回 BOM（pi 的 splitBom 会剥掉 U+FEFF，不补就永久丢失） */
  addBom: "" | "utf8" | "utf16le" | "utf16be";
  /** 非 null = 闸门 3 拒绝写入，内容即给模型的下一步指令 */
  reject: string | null;
  warnings: string[];
  /** true = 本次写入真的发生了编码转换（磁盘编码 ≠ 写出编码） */
  transcoding: boolean;
}

function bomFlagFor(encoding: string, verdict: Verdict | null, content: string): WritePlan["addBom"] {
  const enc = encoding.toUpperCase();
  const hadBom = verdict?.bom === true;
  // UTF-16 目标总是写 BOM：无 BOM 的 UTF-16 在字节层无法与二进制区分（每个 ASCII 字符
  // 都带一个 NUL 高位字节），不写 BOM 就等于下一次判定必然失败。
  if (enc === "UTF-16LE") return "utf16le";
  if (enc === "UTF-16BE") return "utf16be";
  if (enc === "UTF-8") return hadBom || content.charCodeAt(0) === 0xfeff ? "utf8" : "";
  return "";
}

function bomBytes(flag: WritePlan["addBom"]): Buffer {
  if (flag === "utf8") return Buffer.from([0xef, 0xbb, 0xbf]);
  if (flag === "utf16le") return Buffer.from([0xff, 0xfe]);
  if (flag === "utf16be") return Buffer.from([0xfe, 0xff]);
  return Buffer.alloc(0);
}

export function planBomBytes(flag: WritePlan["addBom"]): Buffer {
  return bomBytes(flag);
}

/**
 * @param content 模型要写入的 UTF-8 文本（pi 的 edit 可能把 `bom + content` 原样传进来）
 */
export async function resolveWritePlan(absFilePath: string, content: string): Promise<WritePlan> {
  const rule = await ruleFor(absFilePath);
  if (!rule) {
    return { encoding: null, rule: null, kind: "new", verdict: null, addBom: "", reject: null, warnings: [], transcoding: false };
  }
  const warnings = [...rule.warnings];
  const exists = await fileExists(absFilePath);
  const raw = exists ? await readRawOrNull(absFilePath) : null;
  const verdict = raw === null ? null : classifyBuffer(raw, {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  });
  const targetFromConfig = normalizeEncoding(rule.writeEncoding || rule.sourceEncoding);

  // ① 文件不存在 / ② 磁盘纯 ASCII：都按项目规范写（§3.2 关键规则：ASCII 的 .java
  //    里模型新加中文注释，必须按项目编码写，否则项目内混入 UTF-8 中文，构建即崩）
  if (!verdict || verdict.kind === "ascii") {
    const addBom = bomFlagFor(targetFromConfig, verdict, content);
    return {
      encoding: targetFromConfig,
      rule,
      kind: verdict ? "ascii" : "new",
      verdict,
      addBom: applyBomRuleForContent(addBom, content, targetFromConfig, warnings, rule),
      reject: rejectIfBomIntoGB(content, targetFromConfig, rule, absFilePath, warnings),
      warnings,
      transcoding: false,
    };
  }

  // ③ 二进制：任何情况都拒绝（写文本进 .class/.png 必然是灾难）
  if (verdict.kind === "binary") {
    return {
      encoding: null,
      rule,
      kind: "binary",
      verdict,
      addBom: "",
      reject:
        `拒绝写入 ${absFilePath}：文件按二进制处理（前 8192 字节内含 NUL，判定=binary）。` +
        `编码转换不适用于二进制文件。若这确实是文本文件，请改用显式工具处理，或在配置里为该 pattern 设 "force": true 后重试。`,
      warnings,
      transcoding: false,
    };
  }

  // ④ 拿不准就不写（闸门 3）：unknown，或 force 解码已产生 U+FFFD 且该内容真要被写回 GB 系
  if (verdict.kind === "config" && rule.force && verdict.hasFffd && content.includes("\ufffd")) {
    return {
      encoding: null,
      rule,
      kind: "config",
      verdict,
      addBom: "",
      reject:
        `拒写 ${absFilePath}：要写入的内容里含 U+FFFD（替换字符），而目标编码 ${targetFromConfig} 无法表示它。` +
        `常见成因：该文件被 force 按错误编码读出（乱码），再写回就永久变成 '?'。` +
        `先核对配置里的 encoding 是否与文件真实编码一致（或去掉 force 让字节判定接管）。`,
      warnings,
      transcoding: false,
    };
  }
  if (verdict.kind === "unknown") {
    if (rule.force) {
      warnings.push(`force=true 跳过了 unknown 判定，按 ${targetFromConfig} 写出（请写后人工核对）`);
      return {
        encoding: targetFromConfig,
        rule,
        kind: "unknown",
        verdict,
        addBom: bomFlagFor(targetFromConfig, verdict, content),
        reject: null,
        warnings,
        transcoding: true,
      };
    }
    return {
      encoding: null,
      rule,
      kind: "unknown",
      verdict,
      addBom: "",
      reject:
        `拒绝写入 ${absFilePath}：字节判定为 UNKNOWN —— 既不是合法 UTF-8，也不能被候选编码 ` +
        `${(rule.autoCandidates || []).join("/")} 无损回环。先人工确认该文件编码，再在该目录的 ` +
        `".encoding-converter.json" 里为它加一条 {"pattern":"<glob>","encoding":"<编码>","force":true}。`,
      warnings,
      transcoding: false,
    };
  }

  // ⑤ UTF-8 家族：保护规则 —— 不把含非 ASCII 的 UTF-8 文件转成 GB（§3.2 🛡️）
  if (verdict.kind === "utf8" || verdict.kind === "utf8-bom") {
    const wantsGb = isGBEncoding(targetFromConfig);
    if (verdict.kind === "utf8" && !wantsGb) {
      return { encoding: "UTF-8", rule, kind: "utf8", verdict, addBom: bomFlagFor("UTF-8", verdict, content), reject: null, warnings, transcoding: false };
    }
    if (verdict.kind === "utf8-bom") {
      // UTF-8 BOM 文件继续写 UTF-8 BOM（除非 force 转走）
      if (!wantsGb) {
        return { encoding: "UTF-8", rule, kind: "utf8-bom", verdict, addBom: "utf8", reject: null, warnings, transcoding: false };
      }
    }
    const mayConvert = rule.force || rule.protectUtf8 === false;
    if (!mayConvert) {
      warnings.push(
        `已阻止把 UTF-8${verdict.kind === "utf8-bom" ? "(BOM)" : ""} 文件按 ${targetFromConfig} 重写（UTF-8 保护规则）。如需真转换：给该 pattern 加 "force": true。`,
      );
      return {
        encoding: "UTF-8",
        rule,
        kind: verdict.kind,
        verdict,
        addBom: verdict.kind === "utf8-bom" ? "utf8" : "",
        reject: null,
        warnings,
        transcoding: false,
      };
    }
    warnings.push(
      `按 force/protectUtf8=false 将 UTF-8 文件转换为 ${targetFromConfig} —— 这是破坏性语义变更，已按配置执行`,
    );
    return {
      encoding: targetFromConfig,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: "",
      reject: rejectIfBomIntoGB(content, targetFromConfig, rule, absFilePath, warnings),
      warnings,
      transcoding: true,
    };
  }

  // ⑥ UTF-16：保持原样（老 Windows/INI 场景）
  if (verdict.kind === "utf16le" || verdict.kind === "utf16be") {
    const keep = verdict.encoding;
    const forceConvert = rule.force && targetFromConfig !== keep;
    const encoding = forceConvert ? targetFromConfig : keep;
    if (forceConvert) warnings.push(`force=true：UTF-16 文件将按 ${encoding} 重写`);
    return {
      encoding,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: forceConvert ? "" : (encoding === "UTF-16LE" ? "utf16le" : "utf16be"),
      reject: null,
      warnings,
      transcoding: forceConvert,
    };
  }

  // ⑧ cjk / config：写编码由配置决定（允许「读兼容 GBK、写统一 GB18030」）
  const encoding = targetFromConfig;
  // force 跳过了字节判定 → 补一次「不 force 时的字节判定」，用来履行「必须警告」并正确算 transcoding。
  const byteVerdict: Verdict | null = verdict.kind === "config" && raw ? classifyBuffer(raw, null) : null;
  if (byteVerdict && rule.force) {
    if ((byteVerdict.kind === "utf8" || byteVerdict.kind === "utf8-bom") && encoding.toUpperCase() !== "UTF-8") {
      warnings.push(
        `force=true：磁盘上是 ${byteVerdict.kind === "utf8-bom" ? "UTF-8 with BOM" : "UTF-8"} 文件，正在按 ${encoding} 重写 —— 这是破坏性语义变更`,
      );
    }
  }
  // 泛化的不损坏原则（UTF-8 保护规则的一般形式）：磁盘字节必须能在目标编码下
  // 逐字节无损回环，否则这次写入会改变**未被编辑**那部分内容（例如 GB18030 4 字节
  // 扩展区字符被降级成 GBK 的 '?'）——拿不准就不写（闸门 3）。
  if (verdict.kind === "cjk" && !rule.force && !exactRoundTrip(raw!, encoding)) {
    return {
      encoding: null,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: "",
      reject:
        `拒写 ${absFilePath}：磁盘字节判定为 ${verdict.encoding}，但目标写编码 ${encoding}` +
        `${rule.matchedPattern ? `（来自 override "${rule.matchedPattern}"）` : `（来自 ${rule.configDir} 的配置）`}不能无损表示它们` +
        `（逐字节回环不相等，未改动的部分会被静默改写）。` +
        `建议：把该作 ${isGBEncoding(encoding) && encoding.toUpperCase() !== "GB18030" ? " writeEncoding 改成 GB18030（它是 GBK 的严格超集，对既有 GBK 内容逐字节不变，性质 P-4）" : "该 override 的 encoding 改成 ${verdict.encoding}"}；` +
        `若该文件确实是个例外，删了/改窄那条 override；若真要降级转换，在该 pattern 上显式 "force": true。`,
      warnings,
      transcoding: false,
    };
  }
  // 磁盘内容的「真实编码基准」：force 时取补判定的结果，否则取判定本身。
  let baselineEncoding: string;
  if (verdict.kind !== "config") baselineEncoding = verdict.encoding;
  else if (byteVerdict && (byteVerdict.kind === "utf8" || byteVerdict.kind === "utf8-bom")) baselineEncoding = "UTF-8";
  else if (byteVerdict && byteVerdict.kind === "cjk") baselineEncoding = byteVerdict.encoding;
  else baselineEncoding = encoding;
  const transcoding = normalizeEncoding(baselineEncoding) !== normalizeEncoding(encoding);
  if (transcoding) {
    warnings.push(
      `磁盘判定 ${baselineEncoding} → 按配置写出 ${encoding}（${rule.matchedPattern ? `override "${rule.matchedPattern}"` : rule.configDir}）`,
    );
  }
  return {
    encoding,
    rule,
    kind: verdict.kind,
    verdict,
    addBom: bomFlagFor(encoding, verdict, content),
    reject: rejectIfBomIntoGB(content, encoding, rule, absFilePath, warnings),
    warnings,
    transcoding,
  };
}

/**
 * §3.2 BOM 规则（修缺陷 4）：content 以 U+FEFF 开头而目标编码是 GB 系 → 抛错。
 * iconv.encode('\\uFEFF'+..,'gbk') 的首字节是 0x3F，静默毁掉文件头。
 */
function rejectIfBomIntoGB(
  content: string,
  encoding: string,
  rule: ResolvedConfig,
  absPath: string,
  warnings: string[],
): string | null {
  const hasBomChar = content.charCodeAt(0) === 0xfeff;
  if (!hasBomChar) return null;
  if (rule.force) {
    warnings.push("force=true 且 content 带前导 U+FEFF：BOM 已剥离后再按目标编码写出（GB 系无法表示 BOM）");
    return null;
  }
  if (!isGBEncoding(encoding)) return null;
  return (
    `拒绝写入 ${absPath}：该文件是 UTF-8 with BOM，而目标编码 ${encoding} 无法表示 BOM ` +
    `（iconv 会把 U+FEFF 编成 '?'=0x3F，头部永久损坏）。` +
    `请选择：① 把该目录/该 pattern 的 writeEncoding 设为 UTF-8；② 先转成无 BOM 的 UTF-8；` +
    `③ 确需转 GB 系时在对应 override 里显式写 "force": true。`
  );
}

/** U+FEFF 出现在「目标是 UTF-8/UTF-16」时正常编码回去；GB 系由 rejectIfBomIntoGB 拦下。 */
function applyBomRuleForContent(
  flag: WritePlan["addBom"],
  content: string,
  encoding: string,
  warnings: string[],
  rule: ResolvedConfig,
): WritePlan["addBom"] {
  if (content.charCodeAt(0) !== 0xfeff) return flag;
  if (isGBEncoding(encoding)) return flag; // 交给 reject 分支处理
  if (encoding.toUpperCase() === "UTF-8" && flag === "") {
    warnings.push("content 带前导 U+FEFF，按 UTF-8 写出 BOM");
    return "utf8";
  }
  return flag;
}

// ── v1 兼容包装（grep.ts 与既有测试用） ────────────────────────────────────

/** 该文件读侧应使用的编码；null = 无配置（透传）。 */
export async function resolveReadEncoding(absFilePath: string): Promise<string | null> {
  const plan = await resolveReadPlan(absFilePath);
  if (!plan) return null;
  if (plan.verdict.kind === "binary" || plan.verdict.kind === "unknown") return plan.verdict.encoding === "BINARY" ? "BINARY" : "UNKNOWN";
  return plan.encoding;
}

/** 该文件写侧应使用的编码；null = 无配置（透传）。 */
export async function resolveWriteEncoding(absFilePath: string): Promise<string | null> {
  const plan = await resolveWritePlan(absFilePath, "");
  if (!plan.encoding) return null;
  return plan.encoding;
}

export type { ResolvedConfig };
