// src/pi-settings.ts — 镜像 pi 自己的 shell 设置（P5 覆盖 bash 工具时必须带上，否则是行为回归）
//
// pi 创建内置 bash/powershell 时传的是
//   { commandPrefix: settingsManager.getShellCommandPrefix(), shellPath: settingsManager.getShellPath() }
// （pi `core/agent-session.js` _buildRuntime）。扩展 `registerTool` 会**整个替换**这个定义，
// 而扩展 API 不暴露 SettingsManager —— 所以这两个键得自己从同一份 settings.json 里读，
// 否则用户设了 shellPath / commandPrefix 之后装了本扩展就会悄悄失效。
//
// 只读这两个键，别的（模型、主题、packages…）一概不碰。
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { stripJsonComments } from "./config";

export interface PiShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(stripJsonComments(readFileSync(file, "utf-8"))) as Record<string, unknown>;
  } catch {
    return null; // 坏 JSON：交给 pi 自己去报，我们只当没有
  }
}

function normalizeShellPath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function pick(src: Record<string, unknown> | null): PiShellSettings {
  const out: PiShellSettings = {};
  const sp = normalizeShellPath(src?.shellPath);
  if (sp) out.shellPath = sp;
  if (typeof src?.shellCommandPrefix === "string" && src.shellCommandPrefix) {
    out.shellCommandPrefix = src.shellCommandPrefix;
  }
  return out;
}

/** 项目级覆盖用户级（与 pi 的 settings 合并顺序一致） */
export function readPiShellSettings(cwd: string): PiShellSettings {
  let globalFile: string;
  try {
    globalFile = path.join(getAgentDir(), "settings.json");
  } catch {
    globalFile = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json");
  }
  const merged: PiShellSettings = { ...pick(readJson(globalFile)), ...pick(readJson(path.join(cwd, CONFIG_DIR_NAME, "settings.json"))) };
  return merged;
}
