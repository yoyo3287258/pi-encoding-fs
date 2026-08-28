// src/encoding/stream-transcode.ts — P5（§5.5）：shell 输出的流式转码
//
// 为什么必须在字节层做：pi 的 bash/powershell 用 `new TextDecoder()`（**非 fatal**）流式解码
// （pi `core/tools/output-accumulator.js:25`），非法字节会变成 U+FFFD。等到 tool_result 再看
// 就已经不可逆了，所以只能包住 BashOperations.exec 的 onData。
//
// 决策原则（和读文件同一套，不引入任何"猜"）：
//  1. 攒够样本后跑 classifyBuffer（确定性字节判定）。
//  2. **合法 UTF-8 / ASCII → 原样透传，一个字节都不改**（最常见情况，也是零风险的保证）。
//  3. 判定为 binary / unknown → 也不改（宁可不转，也不污染二进制或不可判定的字节）。
//  4. 判定为 cjk → 用判定出的编码转。显式指定的编码（配置里的 "GBK" 或 `type foo.java` 那个
//     文件自身的读编码）只在"字节不是合法 UTF-8"时作为优先候选 —— UTF-8 保护永远高于配置。
//  5. 都判不出来才退到 OS 控制台码页（Windows chcp / POSIX LC_*）。
//
// 难点是跨 chunk 的多字节截断：GBK 的一个汉字可能正好被拆在两个 data 事件里。这里用
// iconv-lite 的 stateful decoder（它内部保留半个字符），不再自己拼字节。

import iconv from "iconv-lite";
import { classifyBuffer, type Verdict } from "./classify";

export type TranscodeModeName = "passthrough" | "transcoded" | "binary-passthrough" | "empty";

export interface OutputTranscoderOptions {
  /** 字节判定的候选链（来自配置的 autoCandidates） */
  candidates: string[];
  /** 字节判定说"配置兜底"时用的编码（OS 码页或配置里的 sourceEncoding） */
  fallbackEncoding: string | null;
  /**
   * 显式优先编码：配置写了具体编码名，或 `type <file>` 命中了该文件的读编码。
   * 只在字节不是合法 UTF-8 时生效（UTF-8 保护优先）。
   */
  preferredEncoding?: string | null;
  /** 攒多少字节做判定（默认 64KB；再多也没意义，判定只看前缀） */
  sampleBytes?: number;
}

export interface TranscodeStats {
  mode: TranscodeModeName;
  encoding: string | null;
  inBytes: number;
  outBytes: number;
  /** 转码后仍出现 U+FFFD（说明这份输出里混着目标编码也装不下的字节） */
  lossy: boolean;
  verdict: Verdict | null;
  /** 决策依据，给人/模型看的一句话 */
  basis: string | null;
}

const DEFAULT_SAMPLE = 64 * 1024;

export interface OutputTranscoder {
  push(chunk: Buffer): Buffer;
  finish(): Buffer;
  stats(): TranscodeStats;
}

export function createOutputTranscoder(opts: OutputTranscoderOptions): OutputTranscoder {
  const sampleBytes = opts.sampleBytes ?? DEFAULT_SAMPLE;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let decided = false;
  let decoder: ReturnType<typeof iconv.getDecoder> | null = null;
  const stats: TranscodeStats = {
    mode: "passthrough",
    encoding: null,
    inBytes: 0,
    outBytes: 0,
    lossy: false,
    verdict: null,
    basis: null,
  };

  function decide(all: Buffer): void {
    decided = true;
    if (all.length === 0) {
      stats.mode = "empty";
      return;
    }
    const sample = all.subarray(0, sampleBytes);
    // 不碰的分支：透传**已扣住的字节**（否则前面扣住的输出会直接丢失）
    const emitRaw = (mode: TranscodeModeName, basis: string) => {
      stats.mode = mode;
      stats.basis = basis;
      stats.outBytes += all.length;
      outBufs.push(all);
    };
    // 流式场景特有关节：`head -c N` / 64KB 样本边界 / 子进程被切一刀，都可能把
    // 一个 UTF-8 字符截成两半。这时“严格解码失败”不代表输出不是 UTF-8。
    // 只有当末尾确实是“合法的 UTF-8 序列前缀”（而不是一些杂散的续字节）才放行，
    // 否则“丢掉最后 2 字节就变 ASCII”会把真正的 GBK 输出误判成 UTF-8。
    const truncated = incompleteUtf8Tail(sample);
    if (truncated > 0 && isUtf8Valid(sample.subarray(0, sample.length - truncated))) {
      emitRaw("passthrough", "输出是合法 UTF-8（末尾半个字符不当事）");
      return;
    }
    const v = classifyBuffer(sample, {
      sourceEncoding: opts.fallbackEncoding ?? "GB18030",
      autoCandidates: opts.candidates,
      force: false,
    });
    stats.verdict = v;
    // 2/3：合法 UTF-8、ASCII、二进制、判不出来 → 一律不碰
    if (v.kind === "utf8" || v.kind === "utf8-bom" || v.kind === "ascii") {
      emitRaw("passthrough", `输出本身是合法 ${v.encoding}，原样透传`);
      return;
    }
    if (v.kind === "binary") {
      emitRaw("binary-passthrough", `输出判定为 binary，不转码`);
      return;
    }
    // 显式编码（配置写了具体编码名，或 `type <file>` 命中该文件自身的读编码）可以接管
    // “字节判不出来”的情况：这里只是在选“把输出当什么编码显示”，不涉及磁盘，
    // 所以“用户显指令”高于“我们判不出来”（判不出来时旧行为是直接丢给模型看乱码）。
    if (v.kind === "unknown" && !opts.preferredEncoding) {
      emitRaw("binary-passthrough", `输出判定为 unknown（不可判定），不转码`);
      return;
    }
    // 4：cjk → 判定结果；config → 兜底编码
    let enc: string | null = null;
    let basis = "";
    if (opts.preferredEncoding && !isUtf8Valid(sample)) {
      enc = opts.preferredEncoding;
      basis = `按显式指定的 ${enc} 转码（字节不是合法 UTF-8）`;
    } else if (v.kind === "cjk") {
      enc = v.encoding;
      basis = `字节判定为 ${enc}（候选互校）`;
    } else if (opts.fallbackEncoding) {
      enc = opts.fallbackEncoding;
      basis = `字节判不出来，退到配置的 ${enc}`;
    }
    if (!enc) {
      emitRaw("binary-passthrough", "没有可用的目标编码，原样透传");
      return;
    }
    stats.mode = "transcoded";
    stats.encoding = enc;
    stats.basis = basis;
    decoder = iconv.getDecoder(enc);
    // 把已攒下的字节走一遍转码
    const text = decoder.write(all);
    pushOut(text);
  }

  function pushOut(text: string): void {
    if (!text) return;
    if (text.includes("\uFFFD")) stats.lossy = true;
    const buf = Buffer.from(text, "utf-8");
    stats.outBytes += buf.length;
    outBufs.push(buf);
  }

  let outBufs: Buffer[] = [];

  return {
    push(chunk: Buffer): Buffer {
      stats.inBytes += chunk.length;
      outBufs = [];
      if (!decided) {
        pending.push(chunk);
        pendingLen += chunk.length;
        if (pendingLen < sampleBytes) return Buffer.alloc(0); // 还没攒够，先扣住
        const all = Buffer.concat(pending, pendingLen);
        pending = [];
        pendingLen = 0;
        decide(all);
        return Buffer.concat(outBufs);
      }
      if (decoder) {
        pushOut(decoder.write(chunk));
        return Buffer.concat(outBufs);
      }
      stats.outBytes += chunk.length;
      return chunk; // 透传：原字节
    },

    finish(): Buffer {
      outBufs = [];
      if (!decided) {
        const all = pending.length ? Buffer.concat(pending, pendingLen) : Buffer.alloc(0);
        pending = [];
        pendingLen = 0;
        decide(all);
        return Buffer.concat(outBufs);
      }
      if (decoder) {
        pushOut(decoder.end() ?? "");
        decoder = null;
      }
      return Buffer.concat(outBufs);
    },

    stats(): TranscodeStats {
      return { ...stats };
    },
  };
}

/** 只在"是否合法 UTF-8"这一个点上用，不关心错误位置 */
function isUtf8Valid(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回末尾“不完整的 UTF-8 序列”的字节数（0 = 没有）。例：
 *  `… E2 94`（“─” = E2 94 80 的开头两个字节）→ 2
 *  `… B4`（杂散续字节）→ 0（不能当截断处理）
 */
export function incompleteUtf8Tail(buf: Buffer): number {
  const max = Math.min(3, buf.length);
  for (let k = max; k >= 1; k--) {
    const start = buf.length - k;
    const lead = buf[start];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    if (need === 0) continue; // 不是 lead byte（要么是可解码的 ASCII，要么是杂续字节）
    if (k >= need) continue; // 序列完整 → 不是截断
    for (let i = start + 1; i < buf.length; i++) {
      if ((buf[i] & 0xc0) !== 0x80) return 0; // 续字节不对 → 不是合法前缀
    }
    return k;
  }
  return 0;
}
