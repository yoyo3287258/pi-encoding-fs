// src/encoding/converter.ts
import iconv from "iconv-lite";

export function isGBEncoding(encoding: string): boolean {
  const upper = encoding.toUpperCase();
  return upper.includes("GB") || upper === "GB2312" || upper === "GBK" || upper === "GB18030";
}

export function resolveFileEncoding(
  detectedEncoding: string | null,
  detectedConfidence: number,
  resolvedSourceEncoding: string,
  confidenceThreshold: number,
): string {
  if (!isGBEncoding(resolvedSourceEncoding)) {
    return "UTF-8";
  }
  if (detectedEncoding && detectedConfidence >= confidenceThreshold && isGBEncoding(detectedEncoding)) {
    return detectedEncoding;
  }
  return resolvedSourceEncoding;
}

export function decodeToUtf8(buffer: Buffer, encoding: string): string {
  return iconv.decode(buffer, encoding);
}

export function encodeFromUtf8(text: string, encoding: string): Buffer {
  return iconv.encode(text, encoding);
}
