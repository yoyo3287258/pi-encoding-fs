// src/operations.ts
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
} from "@earendil-works/pi-coding-agent";
import { resolveReadEncoding, resolveWriteEncoding } from "./resolve";
import { decodeToUtf8, encodeFromUtf8 } from "./encoding/converter";
import { detectLineEnding, restoreLineEndings, type LineEndingStyle } from "./encoding/line-endings";

async function readAsUtf8Buffer(absPath: string): Promise<Buffer> {
  const raw = await readFile(absPath);
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
    return;
  }
  const style = await detectExistingLineEnding(absPath);
  const restored = style ? restoreLineEndings(utf8content, style) : utf8content;
  await writeFile(absPath, encodeFromUtf8(restored, enc));
}

export function makeReadOperations(): ReadOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    access: (absPath) => access(absPath, constants.R_OK),
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
