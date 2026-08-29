// src/shell.ts — P5（§5.5）：把 bash/powershell 的字节输出转成 UTF-8
//
// 注入点是 pi 公开的 `BashOperations.exec`（`onData(chunk: Buffer)`）。整条链是：
//   子进程 stdout/stderr →(Buffer)→ 我们的 onData 包装 →(Buffer)→ pi 的 OutputAccumulator
//   →（pi 用非 fatal 的 TextDecoder 解成文本，非法字节变 U+FFFD）
// 所以转码必须在进 accumulator 之前做完，输出必须是**合法 UTF-8 的 Buffer**。
//
// 默认关闭：只有 `.encoding-converter.json` 里显式写了 `transcodeBash` 才会走到这里
// （`index.ts` 用 `shellRuleFor()` 判断，未开启时连 bash 工具都不覆盖，见 A-1）。

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ShellTranscodeRule } from "./config";
import { createOutputTranscoder, type TranscodeStats } from "./encoding/stream-transcode";
import { resolveReadPlan } from "./resolve";
import { pushShellNote } from "./notify";

/** pi 的工具选项里我们唯一需要的是这两个方法的 exec（见 pi dist/core/tools/bash.d.ts） */
export interface ShellOperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

/** 最近一次 shell 转码的统计（诊断 + 测试用；不做并发保证，同一时刻只有一条命令在跑） */
let lastStats: TranscodeStats | null = null;
export function lastShellTranscodeStats(): TranscodeStats | null {
  return lastStats;
}

// --- OS 控制台码页探测 ---------------------------------------------------------------

const CODEPAGE_TO_ICONV: Record<number, string | null> = {
  65001: null, // UTF-8：本来就是透传
  936: "GB18030", // 简体中文控制台（GBK 的超集，GBK 字节解出来一致）
  2052: "GB18030",
  950: "Big5",
  2053: "Big5" /* EUC-Stripped ?? 保守：Big5 */,
  932: "CP932",
  2054: "Big5-HKSCS" /* 繁体中文 */,
  949: "CP949",
  1252: "windows-1252",
  1250: "windows-1250",
  1251: "windows-1251",
  1254: "windows-1254",
  1256: "windows-1256",
  437: "cp437",
  850: "cp850",
  852: "cp852",
  866: "cp866",
};

let osEncodingCache: string | null | undefined;

/**
 * Windows：`chcp` 的输出本身就是本地码页写的（中文机器上 "活动代码页: 936" 用 GBK 字节），
 * 所以只取 ASCII 数字，别试图解码整行。探测只做一次并缓存；探测不到 → null。
 */
export function osConsoleEncoding(): string | null {
  if (osEncodingCache !== undefined) return osEncodingCache;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("chcp.com", [], { encoding: "latin1", timeout: 5000, windowsHide: true });
      const m = /(\d{3,5})/.exec(out);
      const cp = m ? Number(m[1]) : NaN;
      osEncodingCache = Number.isFinite(cp) ? (CODEPAGE_TO_ICONV[cp] ?? null) : null;
    } catch {
      osEncodingCache = null;
    }
  } else {
    // POSIX：LC_ALL > LC_CTYPE > LANG，形如 zh_CN.GBK / en_US.UTF-8
    const loc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
    const charset = (loc.split(".")[1] || "").split("@")[0].toUpperCase();
    if (!charset || charset === "UTF-8" || charset === "UTF8") osEncodingCache = null;
    else if (charset === "GBK" || charset === "GB2312" || charset === "GB18030") osEncodingCache = "GB18030";
    else if (charset === "BIG5") osEncodingCache = "Big5";
    else if (charset === "EUC-KR") osEncodingCache = "CP949";
    else if (charset === "SHIFTJIS" || charset === "SJIS") osEncodingCache = "CP932";
    else osEncodingCache = charset; // 其它一律按 iconv 编码名试（失败时 classify 会退回透传）
  }
  return osEncodingCache;
}

/** 测试用：清掉码页缓存 */
export function _resetOsEncodingCache(): void {
  osEncodingCache = undefined;
}

// --- “倒文件”命令的路径识别 -------------------------------------------------------------

const DUMP_CMDS = new Set(["type", "cat", "more", "less", "head", "tail", "get-content"]);

/**
 * 从命令里取出「单个文件的原样输出」场景的路径。刻意保守：
 *  - 只认命令段开头的 `type|cat|more|less|head|tail|Get-Content`；
 *  - 带通配符、带多个非 flag 参数（`cat a b`）的情况一律放弃（宁可不转）。
 * 放弃 = 退到字节判定 / OS 码页，依然有兜底。
 */
export function dumpCommandPath(command: string): string | null {
  const segments = command.split(/[|;&\n]+/);
  for (const seg of segments) {
    const toks = seg
      .trim()
      .match(/(?:"[^"]*"|'[^']*'|[^\s]+)+/g)
      ?.map((t) => t.replace(/^["']|["']$/g, ""));
    if (!toks || toks.length < 2) continue;
    const cmd = toks[0].toLowerCase().replace(/\.exe$/, "");
    if (!DUMP_CMDS.has(cmd)) continue;
    const args = toks.slice(1);
    // flag（-n / -Head）与“flag 的位置参数”（head -n 5 里的 5）都不是路径；
    // 真正叫“5”的文件几乎不存在（带扩展名的 5.java 不会被误杀）。
    const paths = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a) && a !== ">" && a !== ">>");
    if (paths.length !== 1) continue;
    const p = paths[0];
    if (/[*?\[\]]/.test(p)) continue; // 通配符 → 多个文件，编码未必一致，放弃
    return p;
  }
  return null;
}

/** 该文件自己的读编码（不是 UTF-8 / 不是二进制才返回） */
export async function fileDumpEncodingForCommand(command: string, cwd: string): Promise<string | null> {
  const rel = dumpCommandPath(command);
  if (!rel) return null;
  const abs = path.resolve(cwd, rel);
  try {
    const plan = await resolveReadPlan(abs);
    if (!plan || !plan.transcoded) return null; // UTF-8 / 透传场景，本来就不用转
    if (plan.verdict.kind === "binary" || plan.verdict.kind === "unknown") return null;
    return plan.encoding;
  } catch {
    return null;
  }
}

// --- 包装 -------------------------------------------------------------------------

/** 包一层 operations：输出按 rule 转码；关闭时（rule=null）原样返回、不做任何包装 */
export function makeTranscodingShellOperations(base: ShellOperationsLike, rule: ShellTranscodeRule): ShellOperationsLike {
  return {
    exec: async (command, cwd, options) => {
      const explicit = typeof rule.mode === "string" && rule.mode !== "auto" ? rule.mode : null; // shellRuleFor 已保证 mode 不为 false
      // 三层优先级（实测教训：把 OS 码页当“判定优先级”会让英文 Windows（码页 437）
      // 把 GBK 字节解成框线乱码，比不转更糟 —— CI 上跑出来的真 bug）：
      //   ① 显式指令：`type <file>` 命中该文件自己的读编码，或用户直接把 transcodeBash 写成编码名
      //   ② 字节判定（歧义优先级 = 项目声明的 sourceEncoding）
      //   ③ 兜底：只在判定给出 config 时用得上；码页排最后
      const preferred = (rule.fileDump ? await fileDumpEncodingForCommand(command, cwd) : null) ?? explicit;
      const fallback = rule.sourceEncoding ?? osConsoleEncoding();
      const t = createOutputTranscoder({
        candidates: rule.autoCandidates,
        priorityEncoding: rule.sourceEncoding,
        fallbackEncoding: fallback,
        preferredEncoding: preferred,
      });
      const forward = (buf: Buffer) => {
        if (buf.length > 0) options.onData(buf);
      };
      try {
        return await base.exec(command, cwd, {
          ...options,
          onData: (chunk: Buffer) => forward(t.push(chunk)),
        });
      } finally {
        // 先 flush（此刻 pi 还没 finishOutput：它是等我们的 exec 返回之后才收尾的）
        forward(t.finish());
        lastStats = t.stats();
        const st = lastStats;
        if (st.mode === "transcoded") {
          pushShellNote(
            `bash 输出已由 ${st.encoding} 转成 UTF-8（${st.inBytes}B→${st.outBytes}B；依据：${st.basis ?? "n/a"}${
              st.lossy ? "；注意：转码后仍出现 U+FFFD，说明输出里混着该编码也装不下的字节" : ""
            }）。这是实验特性，可用 transcodeBash:false 关闭。`,
          );
        }
      }
    },
  };
}
