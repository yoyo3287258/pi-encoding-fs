// tools/bench-p3.mjs — A-7 延迟 + grep 趟数开销（真实工程，只读 + 一次同内容写）
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const iconv = require("iconv-lite");
const PROJ = process.env.PROJ || "D:/temp/OAWSSMS";
const RG = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");

const files = [
  ["GBK java (161B)", "src/wsa/java/com/bbg/uniform/wsa/service/ISignService.java"],
  ["GBK java (8.4K)", "src/ai/java/com/bbg/uniform/ai/action/AiOriAccountAction.java"],
  ["UTF-8 java (2.8K)", "src/app/java/com/bbg/uniform/biz/flow/service/impl/FeeowntypeCashitemService.java"],
];

const { makeReadOperations } = await import("../src/operations.ts");
const rd = makeReadOperations();

console.log("== A-7 真实工程（带 .encoding-converter.json）==");
for (const [label, rel] of files) {
  const abs = path.join(PROJ, rel);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) readFileSync(abs);
  const base = (performance.now() - t0) / 10;
  await rd.readFile(abs); // 预热判定缓存
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) await rd.readFile(abs);
  const ours = (performance.now() - t1) / 20;
  console.log(
    label.padEnd(18),
    "裸读", base.toFixed(2) + "ms",
    "| 我们的 read", ours.toFixed(2) + "ms",
    "| 新增", (ours - base).toFixed(2) + "ms",
  );
}

console.log("\n== grep 趟数开销（真实工程 665MB / 25079 文件 / 4380 java）==");
const timed = (args) => {
  const t = performance.now();
  let out = Buffer.alloc(0);
  try {
    out = execFileSync(RG, args, { cwd: PROJ, maxBuffer: 200 * 1024 * 1024 });
  } catch (e) {
    if (e.status !== 1) throw e; // rg 退出码 1 = 无命中，属正常
    out = e.stdout ?? Buffer.alloc(0);
  }
  return { ms: performance.now() - t, n: out.toString("binary").split("\n").filter(Boolean).length };
};
for (let i = 0; i < 2; i++) timed(["--hidden", "-F", "--encoding", "utf-8", "--glob", "*.java", "签名验证", "."]);
const a = timed(["--hidden", "-F", "--encoding", "utf-8", "--glob", "*.java", "签名验证", "."]);
const b = timed(["--hidden", "-F", "--encoding", "gb18030", "--glob", "*.java", "签名验证", "."]);
const c = timed(["--hidden", "-F", "--encoding", "big5", "--glob", "*.java", "签名验证", "."]);
// 另：不限制 glob 时，rg --hidden 会连 .svn/pristine 一起搜（我们实现里永久排除了）
const svn = timed(["--hidden", "-F", "--encoding", "gb18030", "签名验证", "."]);
console.log("UTF-8 趟（≈内置 grep 等价）:", a.ms.toFixed(0) + "ms");
console.log("GB18030 趟:", b.ms.toFixed(0) + "ms", "| Big5 趟:", c.ms.toFixed(0) + "ms");
console.log(
  "我们（非 ASCII 关键字 ≈ 2 趟）:",
  (a.ms + b.ms).toFixed(0) + "ms →",
  "约为内置的 " + ((a.ms + b.ms) / a.ms).toFixed(1) + "x",
);
console.log("命中数: UTF-8 趟", a.n, "| GB18030 趟", b.n, "| Big5 趟（假阳性检查）", c.n);
console.log(
  "不加 --glob 排除 .svn 时的命中数:",
  svn.n,
  "（含 .svn/pristine 的 pristine 副本 → 重复假阳性，所以 DEFAULT_EXCLUDE_DIRS 永久排除）",
);
