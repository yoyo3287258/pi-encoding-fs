// src/notify.ts — 闸门/判定信息的回显通道（P3）
//
// 为什么需要它：`operations` 的 read/write 返回值会被 pi 直接当成**文件内容**使用
// （`edit` 拿 readFile 的结果作基线），所以普通警告不能塞进解码后的文本 —— 那会被下一次
// edit 写回磁盘，变成新的污染（P1 已记录该约束）。
// 这里的做法：operations 只把提示**寄存**在内存里，由 `index.ts` 的 `tool_result` 事件
// （pi 0.84.3 公开能力）在结果发往模型之前追加到工具结果尾部，同时用 `ctx.ui.notify()`
// 给 TUI 里的人看一眼。这样：
//   - 模型能看到（edit/write 的结果文本不是任何后续操作的基线，安全）；
//   - 磁盘永远看不到；
//   - 无配置目录根本不会产生寄存项 → 行为与未装扩展完全一致（A-1）。
import * as path from "node:path";

const MAX_FILES_TRACKED = 256;
const MAX_NOTES_PER_FILE = 6;

const pending = new Map<string, string[]>();

function key(absPath: string): string {
  return path.resolve(absPath).toLowerCase();
}

/** operations 侧登记一条提示（自动去重、限量） */
export function pushEncodingNote(absPath: string, message: string): void {
  if (!message) return;
  const k = key(absPath);
  let list = pending.get(k);
  if (!list) {
    if (pending.size >= MAX_FILES_TRACKED) pending.delete(pending.keys().next().value as string);
    list = [];
    pending.set(k, list);
  }
  if (list.length < MAX_NOTES_PER_FILE && !list.includes(message)) list.push(message);
}

/** 取走并清空（tool_result 处理器用） */
export function drainEncodingNotes(absPath: string): string[] {
  const k = key(absPath);
  const list = pending.get(k);
  if (!list) return [];
  pending.delete(k);
  return list;
}

export function peekEncodingNotes(absPath: string): string[] {
  return pending.get(key(absPath)) ?? [];
}

export function clearEncodingNotes(): void {
  pending.clear();
}

// shell 转码（P5）的提示不按文件路径键（一次命令输出不属于某个文件），用一个不可能
// 被 path.resolve 生成的固定键。
const SHELL_KEY = "\u0000shell-output";

export function pushShellNote(message: string): void {
  if (!message) return;
  const list = pending.get(SHELL_KEY) ?? [];
  if (list.length < MAX_NOTES_PER_FILE && !list.includes(message)) {
    list.push(message);
    pending.set(SHELL_KEY, list);
  }
}

export function drainShellNotes(): string[] {
  const list = pending.get(SHELL_KEY);
  pending.delete(SHELL_KEY);
  return list ?? [];
}

/** 把若干条提示压成一行为工具结果尾部文本（超长截断，保持上下文开销可控） */
export function notesToSuffix(notes: string[], maxChars = 400): string {
  if (!notes.length) return "";
  let text = notes.join("；");
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  return `\n\n[encoding] ${text}`;
}
