// test/helpers/tree.ts — 在 tmpdir 里铺一棵树（fixture 由 test/fixtures/build.ts 生成，不提交二进制）
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface TreeSpecLike {
  dir: string;
  files: { rel: string; buf: Buffer }[];
}

/** 返回 rel -> 绝对路径 */
export function writeTree(base: string, files: { rel: string; buf: Buffer }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    const abs = path.join(base, ...f.rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.buf);
    map.set(f.rel, abs);
  }
  return map;
}

export function writeSpecTree(spec: TreeSpecLike): Map<string, string> {
  return writeTree(spec.dir, spec.files);
}

export const readBytes = (abs: string): Buffer => readFileSync(abs);

export function putConfig(dir: string, cfg: Record<string, unknown> | string): string {
  const p = path.join(dir, ".encoding-converter.json");
  writeFileSync(p, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2), "utf-8");
  return p;
}
