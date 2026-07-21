// src/resolve.ts
import { access } from "node:fs/promises";
import * as path from "node:path";
import { findNearestConfig, resolveOverrideEncoding } from "./config";
import { detectEncoding } from "./encoding/detector";
import { resolveFileEncoding, isGBEncoding } from "./encoding/converter";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveReadEncoding(absFilePath: string): Promise<string | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;

  const sourceEncoding = resolveOverrideEncoding(absFilePath, found);

  // Config explicitly non-GB (e.g. UTF-8 override) -> trust config, skip chardet.
  if (!isGBEncoding(sourceEncoding)) {
    return "UTF-8";
  }

  // Config GB -> only trust high-confidence GB detection, else fall back.
  const detection = await detectEncoding(absFilePath);
  return resolveFileEncoding(
    detection.encoding,
    detection.confidence,
    sourceEncoding,
    found.config.confidenceThreshold,
  );
}

export async function resolveWriteEncoding(absFilePath: string): Promise<string | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;

  // Existing file: preserve its actual encoding (same logic as read).
  if (await fileExists(absFilePath)) {
    return resolveReadEncoding(absFilePath);
  }

  // New file: use nearest-config override/sourceEncoding, no detection.
  const sourceEncoding = resolveOverrideEncoding(absFilePath, found);
  return isGBEncoding(sourceEncoding) ? sourceEncoding : "UTF-8";
}
