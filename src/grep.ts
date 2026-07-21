// src/grep.ts
import { readdir, readFile as fsReadFile, stat } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";
import { Type, type Static } from "typebox";
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
  try {
    const s = await stat(base);
    if (s.isFile()) {
      files.push(base);
    } else if (s.isDirectory()) {
      await walk(base, files);
    }
    // else (other types) → no files
  } catch {
    // base doesn't exist or unreadable → no files
  }

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
