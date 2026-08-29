// src/sysnote.ts — §5.2：条件式系统提示注入（修上游"无条件追加 ~90 token"的全局副作用）
//
// 规则：**只有当前工作目录树里真的存在 `.encoding-converter.json`（或它对该目录生效）才注入**；
// 无配置的目录一个字都不加（§8 A-8「系统提示零增长」）。有配置时内容仍是**常量**，
// 以便 prompt cache 前缀稳定。
import { findNearestConfig, CONFIG_FILENAME } from "./config";
import { existsSync } from "node:fs";
import * as path from "node:path";

/** 有配置时注入的常量提示（实测 ≈55 token，上游那份 ≈90 token） */
export const ENCODING_NOTE = `Encoding (a \`${CONFIG_FILENAME}\` applies here): \`read\`/\`write\`/\`edit\`/\`grep\` convert per file by deterministic byte classification — no guessing, no subprocess.
Existing files keep their own on-disk encoding; UTF-8 files are protected from being down-converted; a character the target encoding cannot represent fails loudly instead of turning into \`?\`. Never \`iconv\` a file or re-save it as UTF-8.
If a read reports \`[encoding: UNKNOWN]\` or a write is refused: stop and ask the user which encoding is correct — do not guess and do not convert by hand.`;

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "target", "build", "dist", ".next"]);
const SCAN_MAX_DIRS = 400; // 上限：扫不到就按"无配置"处理（宁可少注入，也不要每次启动全量遍历大仓库）

/** 该目录树里是否有任何位置的配置文件（就近向上 + 有限深度向下） */
export async function configAppliesTo(cwd: string): Promise<boolean> {
  if (await findNearestConfig(cwd)) return true;
  if (existsSync(path.join(cwd, CONFIG_FILENAME))) return true;
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  while (stack.length && visited < SCAN_MAX_DIRS) {
    const { dir, depth } = stack.pop()!;
    visited++;
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await import("node:fs")).readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => !e.isDirectory() && e.name === CONFIG_FILENAME) && depth > 0) return true;
    if (depth >= 3) continue;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SCAN_SKIP_DIRS.has(e.name)) {
        stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

/** 返回要追加到系统提示的内容；null = 什么都不加（A-8） */
export async function systemNoteFor(cwd: string): Promise<string | null> {
  return (await configAppliesTo(cwd)) ? ENCODING_NOTE : null;
}
