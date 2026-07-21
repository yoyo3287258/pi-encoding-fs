// test/line-endings.test.ts
import { describe, it, expect } from "vitest";
import { detectLineEnding, restoreLineEndings } from "../src/encoding/line-endings";

describe("line-endings", () => {
  it("detects CRLF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\r\nb\r\nc\n"))).toBe("CRLF");
  });
  it("detects LF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\nb\nc\r\n"))).toBe("LF");
  });
  it("restores to CRLF", () => {
    expect(restoreLineEndings("a\nb\n", "CRLF")).toBe("a\r\nb\r\n");
  });
  it("restores to LF (normalizes existing CRLF first)", () => {
    expect(restoreLineEndings("a\r\nb\n", "LF")).toBe("a\nb\n");
  });
});
