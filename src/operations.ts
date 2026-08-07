// src/operations.ts
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { clearConfigCache } from "./config";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
} from "@earendil-works/pi-coding-agent";
import { resolveReadEncoding, resolveWriteEncoding } from "./resolve";
import { decodeToUtf8, encodeFromUtf8 } from "./encoding/converter";
import { detectLineEnding, restoreLineEndings, type LineEndingStyle } from "./encoding/line-endings";
import {
  detectSupportedImageMimeType,
  detectSupportedImageMimeTypeFromFile,
} from "./encoding/mime";

async function readAsUtf8Buffer(absPath: string): Promise<Buffer> {
  const raw = await readFile(absPath);
  // Images must stay binary. Pi's read tool calls ops.readFile() after MIME
  // detection; running GB→UTF-8 iconv on PNG/JPEG bytes corrupts them and the
  // model receives garbage instead of an image attachment.
  if (detectSupportedImageMimeType(raw)) {
    return raw;
  }
  const enc = await resolveReadEncoding(absPath);
  if (!enc || enc.toUpperCase() === "UTF-8") {
    return raw; // passthrough / already UTF-8
  }
  const text = decodeToUtf8(raw, enc);
  return Buffer.from(text, "utf-8");
}

async function detectExistingLineEnding(absPath: string): Promise<LineEndingStyle | null> {
  try {
    const raw = await readFile(absPath);
    return detectLineEnding(raw);
  } catch {
    return null;
  }
}

async function writeEncoded(absPath: string, utf8content: string): Promise<void> {
  const enc = await resolveWriteEncoding(absPath);
  if (!enc || enc.toUpperCase() === "UTF-8") {
    await writeFile(absPath, utf8content, "utf-8"); // passthrough / UTF-8
  } else {
    const style = await detectExistingLineEnding(absPath);
    const restored = style ? restoreLineEndings(utf8content, style) : utf8content;
    await writeFile(absPath, encodeFromUtf8(restored, enc));
  }
  // Writing the config file changes encoding decisions for the tree below it;
  // invalidate the cache so later read/write/grep reflect the new config.
  if (path.basename(absPath) === ".encoding-converter.json") {
    clearConfigCache();
  }
}

export function makeReadOperations(): ReadOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    access: (absPath) => access(absPath, constants.R_OK),
    // Required: without this hook Pi skips the image branch entirely and treats
    // PNG/JPEG bytes as UTF-8 text (model never gets an image attachment).
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
  };
}

export function makeWriteOperations(): WriteOperations {
  return {
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  };
}

export function makeEditOperations(): EditOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    writeFile: (absPath, content) => writeEncoded(absPath, content),
    access: (absPath) => access(absPath, constants.R_OK | constants.W_OK),
  };
}
