// tools/bench-p5.mjs — transcodeBash 的开销实测
// 用法：node tools/bench-p5.mjs        （需要 node_modules 里有 pi，用于 createLocalBashOperations）
import { performance } from "node:perf_hooks";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const iconv = require("iconv-lite");
const { createOutputTranscoder } = await import("../src/encoding/stream-transcode.ts");
const { makeTranscodingShellOperations } = await import("../src/shell.ts");
const { createLocalBashOperations } = await import("@earendil-works/pi-coding-agent");

const unit = iconv.encode("订单服务初始化完成，报警阈值=85.5 这个文件是 GBK 编码\r\n", "GBK");
const utf8Unit = Buffer.from("order service initialized, threshold=85.5 这是 UTF-8\n", "utf-8");
function repeat(buf, bytes) {
  const parts = [];
  let n = 0;
  while (n < bytes) {
    parts.push(buf);
    n += buf.length;
  }
  return Buffer.concat(parts).subarray(0, bytes);
}
const root = mkdtempSync(path.join(tmpdir(), "p5bench-"));
const fGbk = path.join(root, "gbk.txt");
const fUtf8 = path.join(root, "utf8.txt");
const fBin = path.join(root, "bin.dat");
writeFileSync(fGbk, repeat(unit, 5 * 1024 * 1024));
writeFileSync(fUtf8, repeat(utf8Unit, 5 * 1024 * 1024));
writeFileSync(fBin, repeat(Buffer.concat([Buffer.from([0x00, 0x4c, 0x01, 0x4d]), Buffer.alloc(60, 0x9c)]), 5 * 1024 * 1024));

const rule = {
  mode: "auto",
  fileDump: true,
  sourceEncoding: "GBK",
  autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"],
  configDir: root,
  warnings: [],
};

function timeIt(fn, runs) {
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return { min: xs[0], med: xs[Math.floor(xs.length / 2)] };
}

console.log("== A) 纯转码器 CPU 开销（不含 spawn/pipe）==");
for (const [label, buf] of [
  ["1KB GBK", repeat(unit, 1024)],
  ["64KB GBK", repeat(unit, 64 * 1024)],
  ["5MB GBK", readFileSync(fGbk)],
  ["5MB UTF-8", readFileSync(fUtf8)],
  ["5MB 二进制", readFileSync(fBin)],
]) {
  const t = timeIt(() => {
    const tr = createOutputTranscoder({ candidates: rule.autoCandidates, fallbackEncoding: "GBK" });
    let out = 0;
    for (let i = 0; i < buf.length; i += 16 * 1024) out += tr.push(buf.subarray(i, i + 16 * 1024)).length;
    out += tr.finish().length;
    if (out < 0) throw new Error("unreachable");
  }, 5);
  console.log(
    `${label.padEnd(11)} 中位 ${t.med.toFixed(1)}ms  最快 ${t.min.toFixed(1)}ms  ` +
      `= ${(t.med / (buf.length / 1024 / 1024)).toFixed(1)}ms/MB`,
  );
}

console.log("\n== B) 真实 bash 命令端到端（pi 自己的 createLocalBashOperations）==");
const base = createLocalBashOperations();
const wrapped = makeTranscodingShellOperations(base, rule);
const cmd = (f) => `node -e "process.stdout.write(require('fs').readFileSync('${f.replace(/\\/g, "/")}'))"`;
for (const [label, f] of [
  ["echo 小输出", null],
  ["5MB GBK", fGbk],
  ["5MB UTF-8", fUtf8],
  ["5MB 二进制", fBin],
]) {
  const c = f ? cmd(f) : "echo hello world";
  const run = (ops) => {
    let bytes = 0;
    return ops
      .exec(c, root, { onData: (b) => (bytes += b.length) })
      .then((r) => ({ ...r, bytes }));
  };
  let baseT = { min: 0, med: 0 };
  let wrapT = { min: 0, med: 0 };
  // 各自跑 4 次取最快/中位（spawn 抖动远大于转码开销）
  const samples = async (ops) => {
    const xs = [];
    let bytes = 0;
    for (let i = 0; i < 4; i++) {
      const t = performance.now();
      const r = await run(ops);
      xs.push(performance.now() - t);
      bytes = r.bytes;
    }
    xs.sort((a, b) => a - b);
    return { min: xs[0], med: xs[2], bytes };
  };
  const b = await samples(base);
  const w = await samples(wrapped);
  baseT = b;
  wrapT = w;
  console.log(
    `${label.padEnd(11)} 基线 中位 ${b.med.toFixed(0)}ms/最快 ${b.min.toFixed(0)}ms  ` +
      `│ 开启后 中位 ${w.med.toFixed(0)}ms/最快 ${w.min.toFixed(0)}ms  ` +
      `│ 中位差 ${(w.med - b.med).toFixed(0)}ms  │ 输出 ${bytesMB(b.bytes)}→${bytesMB(w.bytes)}`,
  );
}
console.log("\n（基线本身 = node 冷启动 + 读文件 + 管道，几十毫秒级；转码是加在这之上的增量）");

function bytesMB(n) {
  return (n / 1024 / 1024).toFixed(2) + "MB";
}
