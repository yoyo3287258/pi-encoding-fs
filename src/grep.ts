// src/grep.ts
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import {
  createGrepToolDefinition,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { findNearestConfig, type FoundConfig } from "./config";

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

/** Directories always excluded from recursive search. */
const DEFAULT_EXCLUDE_DIRS = [".git", ".svn", ".hg", "node_modules"];

const DEFAULT_LIMIT = 1000;
const MAX_OUTPUT_LINES = 2000;

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
  if (tryRg("rg")) {
    _rgCache = "rg";
    return _rgCache;
  }
  const vscode = findRgFromVscode();
  if (vscode) {
    _rgCache = vscode;
    return _rgCache;
  }
  _rgCache = null;
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

// ── ripgrep invocation ───────────────────────────────────────────────

/** WHATWG encoding label for ripgrep's --encoding. UTF-8 uses rg's default (no flag). */
function rgEncodingLabel(encoding: string): string | null {
  const up = encoding.toUpperCase();
  if (up === "UTF-8" || up === "UTF8") return null; // rg default handles UTF-8
  return encoding.toLowerCase(); // gb18030 / gbk / gb2312 are valid WHATWG labels
}

function buildRgArgs(input: GrepInput, group: EncodingGroup, base: string): string[] {
  const args: string[] = ["--no-heading", "--line-number", "--color", "never"];
  const enc = rgEncodingLabel(group.encoding);
  if (enc) args.push("--encoding", enc);
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.context !== undefined) args.push("--context", String(input.context));

  // Default excludes + override-dir excludes (default group only).
  // Use **/dir/** so exclusion holds at any depth (rg anchors bare globs to the
  // search root, which is unreliable when the root is an absolute path).
  for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--glob", `!**/${d}/**`);
  for (const d of group.excludeDirs) args.push("--glob", `!**/${d}/**`);

  // User glob (include filter).
  if (input.glob) args.push("--glob", input.glob);

  // Pattern (terminate flags so a leading-dash pattern isn't misparsed).
  args.push("--regexp", input.pattern);

  // Search targets: override group searches its dirs; default group searches base.
  if (group.includeDirs.length) {
    for (const d of group.includeDirs) args.push(path.join(base, d));
  } else {
    args.push(base);
  }
  return args;
}

function runRg(rg: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    proc.on("error", () => resolve({ code: -1, stdout: "", stderr: "spawn error" }));
  });
}

/**
 * Encoding-aware search backed by ripgrep. Returns formatted results, or
 * `null` if ripgrep is unavailable (caller should fall back to built-in grep).
 *
 * With a nearest config, searches each encoding group with `rg --encoding`.
 * Without a config, runs a single default (UTF-8) rg search — equivalent to
 * plain ripgrep behaviour.
 */
export async function searchFiles(rootAbs: string, input: GrepInput): Promise<string | null> {
  const rg = findRg();
  if (!rg) return null;

  const base = input.path ? path.resolve(rootAbs, input.path) : rootAbs;
  const found = await findNearestConfig(base);

  const groups: EncodingGroup[] = found
    ? buildEncodingGroups(found)
    : [{ encoding: "UTF-8", includeDirs: [], excludeDirs: [] }];

  const collected: string[] = [];
  for (const group of groups) {
    const args = buildRgArgs(input, group, base);
    const { code, stdout } = await runRg(rg, args);
    // rg exit: 0 = matches, 1 = no matches, 2 = error. Ignore per-group errors
    // (e.g. an override dir that doesn't exist) and keep other groups' results.
    if ((code === 0 || code === 1) && stdout) {
      for (const line of stdout.split("\n")) {
        if (line.trim()) collected.push(line);
      }
    }
  }

  if (collected.length === 0) return "No matches found.";

  const limit = input.limit ?? DEFAULT_LIMIT;
  let lines = collected;
  if (lines.length > limit) {
    lines = lines.slice(0, limit);
  }
  if (lines.length > MAX_OUTPUT_LINES) {
    const extra = lines.length - MAX_OUTPUT_LINES;
    lines = lines.slice(0, MAX_OUTPUT_LINES);
    lines.push(`... (${extra} more lines truncated — use a more specific pattern or 'limit')`);
  }
  return lines.join("\n");
}

// ── Tool definition ──────────────────────────────────────────────────

export function createEncodingGrepDefinition(cwd: string): ToolDefinition<typeof grepSchema> {
  // Built-in grep def: used as a fallback when rg is unavailable. We do NOT spread
  // its renderers (their details type differs); our schema matches the built-in
  // exactly, so Pi's default rendering applies when we omit render slots.
  const builtin = createGrepToolDefinition(cwd);

  return {
    name: "grep",
    label: "grep (encoding aware)",
    description:
      "Search file contents by regex. Encoding-aware: transparently searches GB18030/GBK/GB2312 files, " +
      "including Chinese patterns. Excludes .git/node_modules by default.",
    parameters: grepSchema,
    async execute(
      toolCallId: string,
      params: GrepInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof builtin.execute>[3],
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const text = await searchFiles(cwd, params);
      if (text === null) {
        // ripgrep unavailable → delegate to Pi's built-in grep (schema-compatible).
        return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
