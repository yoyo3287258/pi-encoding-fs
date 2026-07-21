// src/config.ts
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";

export interface OverrideRule {
  pattern: string;
  sourceEncoding: string;
}

export interface EncodingConfig {
  sourceEncoding: string;
  confidenceThreshold: number;
  overrides?: OverrideRule[];
}

export interface FoundConfig {
  config: EncodingConfig;
  configDir: string;
}

const DEFAULTS = { sourceEncoding: "GB18030", confidenceThreshold: 0.8 };

// dir -> EncodingConfig | null (checked, none found in this exact dir)
const dirCache = new Map<string, EncodingConfig | null>();

export function clearConfigCache(): void {
  dirCache.clear();
}

async function loadConfigInDir(dir: string): Promise<EncodingConfig | null> {
  if (dirCache.has(dir)) return dirCache.get(dir) ?? null;
  const p = path.join(dir, ".encoding-converter.json");
  try {
    const parsed = JSON.parse(await readFile(p, "utf-8"));
    const config: EncodingConfig = { ...DEFAULTS, ...parsed };
    dirCache.set(dir, config);
    return config;
  } catch {
    dirCache.set(dir, null);
    return null;
  }
}

export async function findNearestConfig(startDir: string): Promise<FoundConfig | null> {
  let cur = path.resolve(startDir);
  while (true) {
    const config = await loadConfigInDir(cur);
    if (config) return { config, configDir: cur };
    const parent = path.dirname(cur);
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

export function resolveOverrideEncoding(absFilePath: string, found: FoundConfig): string {
  const { config, configDir } = found;
  if (!config.overrides?.length) return config.sourceEncoding;
  const rel = path.relative(configDir, absFilePath).replace(/\\/g, "/");
  const matches = config.overrides
    .map((rule, index) => ({ rule, score: scoreSpecificity(rule.pattern), index }))
    .filter((item) => {
      if (!item.rule.pattern) return false;
      const isBare = !item.rule.pattern.includes("/");
      return micromatch.isMatch(rel, item.rule.pattern, isBare ? { matchBase: true } : undefined);
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return matches[0]?.rule.sourceEncoding ?? config.sourceEncoding;
}
