#!/usr/bin/env node
// tools/scan-encoding.mjs — 混合编码扫描器（需求文档 §6.3/§10 P4 交付物；P1 前作为决策取证工具）
//
// 零依赖（仅用仓库既有 iconv-lite），按 §3.1 的确定性判定顺序对整文件分类，
// 输出「每种扩展名的编码画像 + 异常文件清单」，用于决定 .encoding-converter.json
// 的 sourceEncoding / writeEncoding / overrides 清单。
//
// 判定链与 classify.ts 保持一致（顺序即优先级）：
//   空 → UTF-8BOM → UTF-16LE/BE BOM → 含 NUL(前8192B)=binary → 纯ASCII
//   → 严格整文件 UTF-8 → 多字节候选逐字节回环 + 无 U+FFFD
//
// 用法:
//   node tools/scan-encoding.mjs <root> [--ext java,jsp,xml] [--out report.csv]
//        [--max-mb 50] [--follow-symlinks] [--list-unknown]
// 注意：单字节编码（ISO-8859-1 / Windows-125x）对任意字节都能回环，故永不进候选
//       —— 它们只能靠配置 force 指定（性质 P-6），本扫描器会把「合法 UTF-8 且含非ASCII」
//       与「非 UTF-8」分开统计，让你能判断是否存在 ISO-8859-1 文件被当成 UTF-8 的情形。
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const argv = process.argv.slice(2);
const root = argv[0] && !argv[0].startsWith("--") ? path.resolve(argv[0]) : process.cwd();
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const extFilter = String(flag("ext", "") || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const outCsv = flag("out", null);
const maxBytes = Number(flag("max-mb", 50)) * 1024 * 1024;
const listUnknown = !!flag("list-unknown", false);

const SKIP_DIRS = new Set([".git", ".svn", ".hg", ".idea", "node_modules", ".pi"]);
// 已知二进制扩展名：直接归入 binary，避免整读 665MB 里的图片/class/jar。
const BINARY_EXT = new Set([
  "class", "jar", "war", "ear", "zip", "gz", "tgz", "bz2", "7z", "rar",
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "tif", "tiff", "webp", "ico",
  "ttf", "otf", "eot", "woff", "woff2", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "so", "dll", "exe", "bin", "dat", "jks", "keystore", "ser",
  "mp3", "mp4", "avi", "swf", "flv", "wav", "mar", "xdb", "scc",
]);
const CANDIDATES = ["GB18030", "GBK", "GB2312", "Big5", "Shift_JIS", "EUC-KR", "EUC-JP"];

const startsWith = (b, sig) => sig.every((x, i) => b[i] === x);
const hasNul = (b, limit = 8192) => b.subarray(0, Math.min(b.length, limit)).includes(0);
const isAllAscii = (b) => { for (let i = 0; i < b.length; i++) if (b[i] > 0x7f) return false; return true; };
function isValidUtf8(b) { try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } }
const roundTrips = (b, e) => { try { return Buffer.compare(iconv.encode(iconv.decode(b, e), e), b) === 0; } catch { return false; } };

function classify(b) {
  if (b.length === 0) return { kind: "empty", enc: "UTF-8", pass: [] };
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return { kind: "utf8-bom", enc: "UTF-8", pass: [] };
  if (startsWith(b, [0xff, 0xfe])) return { kind: "utf16le", enc: "UTF-16LE", pass: [] };
  if (startsWith(b, [0xfe, 0xff])) return { kind: "utf16be", enc: "UTF-16BE", pass: [] };
  if (hasNul(b)) return { kind: "binary", enc: "BINARY", pass: [] };
  if (isAllAscii(b)) return { kind: "ascii", enc: "UTF-8", pass: [] };
  if (isValidUtf8(b)) return { kind: "utf8", enc: "UTF-8", pass: [] };
  const pass = CANDIDATES.filter((e) => roundTrips(b, e) && !iconv.decode(b, e).includes("\ufffd"));
  if (pass.length === 0) return { kind: "unknown", enc: "UNKNOWN", pass: [] };
  return { kind: "cjk", enc: pass[0], pass };
}

const lineEndingOf = (b) => {
  let crlf = 0, lf = 0;
  const n = Math.min(b.length, 262144); // 行尾只取样足够判断风格，不影响编码判定
  for (let i = 0; i < n; i++) {
    if (b[i] === 0x0d && b[i + 1] === 0x0a) { crlf++; i++; }
    else if (b[i] === 0x0a) lf++;
  }
  return crlf === 0 && lf === 0 ? "none" : crlf === 0 ? "LF" : lf === 0 ? "CRLF" : crlf >= lf ? "CRLF*" : "LF*";
};

const rows = [];
const stats = new Map(); // ext -> {kind -> count}, plus eol counters
const anomalies = { unknown: [], ambiguous: [], utf8InGbTree: [], gb18030Only: [], oversize: [], bom: [] };
let scanned = 0, skippedBinary = 0;

function bump(ext, key) {
  if (!stats.has(ext)) stats.set(ext, {});
  const s = stats.get(ext);
  s[key] = (s[key] || 0) + 1;
}

(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (e.isSymbolicLink && e.isSymbolicLink()) continue;
    const ext = path.extname(e.name).replace(/^\./, "").toLowerCase() || "(noext)";
    if (extFilter.length && !extFilter.includes(ext)) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (BINARY_EXT.has(ext)) { bump(ext, "binary"); skippedBinary++; continue; }
    if (st.size > maxBytes) { bump(ext, "oversize"); anomalies.oversize.push([p, st.size]); continue; }
    const b = fs.readFileSync(p);
    const c = classify(b);
    bump(ext, c.kind);
    bump(ext, `eol:${lineEndingOf(b)}`);
    if (c.kind !== "ascii") bump(ext, `eol-nonascii:${lineEndingOf(b)}`);
    scanned++;
    const rel = path.relative(root, p).replace(/\\/g, "/");
    rows.push({ rel, ext, kind: c.kind, enc: c.enc, pass: c.pass.join("|"), size: st.size, eol: lineEndingOf(b) });
    if (c.kind === "unknown") anomalies.unknown.push([rel, st.size]);
    if (c.kind === "cjk" && c.pass.length > 1) {
      const only18030 = c.pass.length === 1 && c.pass[0] === "GB18030" ? false : !c.pass.includes("GBK") && c.pass.includes("GB18030");
      anomalies.ambiguous.push([rel, c.pass.join(">"), only18030]);
    }
    if (c.kind === "cjk" && c.pass.length === 1 && c.pass[0] === "GB18030") anomalies.gb18030Only.push(rel);
    if (c.kind === "utf8" || c.kind === "utf8-bom") anomalies.utf8InGbTree.push(rel);
    if (c.kind === "utf8-bom") anomalies.bom.push(rel);
  }
})(root);

const KINDS = ["ascii", "utf8", "utf8-bom", "utf16le", "utf16be", "cjk", "unknown", "binary", "empty", "oversize"];
console.log(`\n扫描根目录: ${root}`);
console.log(`实际判定文件数: ${scanned}（跳过已知二进制扩展名 ${skippedBinary} 个）\n`);
const header = ["ext".padEnd(9), ...KINDS.map((k) => k.slice(0, 7).padStart(8)), "文件数".padStart(8)];
console.log(header.join(" "));
console.log("-".repeat(header.join(" ").length));
const sorted = [...stats.entries()].sort((a, b) => {
  const sa = Object.values(a[1]).reduce((x, y) => x + y, 0);
  const sb = Object.values(b[1]).reduce((x, y) => x + y, 0);
  return sb - sa;
});
for (const [ext, s] of sorted) {
  const total = KINDS.reduce((acc, k) => acc + (s[k] || 0), 0);
  console.log(
    ext.padEnd(9),
    ...KINDS.map((k) => String(s[k] || 0).padStart(8)),
    String(total).padStart(8),
  );
}
console.log("\n行尾风格（仅统计判定为文本的文件；CRLF*=混用但以 CRLF 为主）");
for (const [ext, s] of sorted) {
  const t = ["CRLF", "LF", "CRLF*", "LF*", "none"].map((k) => `${k}:${s[`eol:${k}`] || 0}`).join(" ");
  const na = ["CRLF", "LF", "CRLF*", "LF*", "none"].map((k) => s[`eol-nonascii:${k}`] || 0).reduce((a, b) => a + b, 0);
  if (s.ascii || s.utf8 || s.cjk || s["utf8-bom"]) console.log(`  ${ext.padEnd(9)} 全部[${t}]  含非ASCII的[${["CRLF","LF","CRLF*","LF*","none"].map((k)=>`${k}:${s[`eol-nonascii:${k}`]||0}`).join(" ")}]`);
}

const gb = rows.filter((r) => r.kind === "cjk");
console.log(`\n多字节 CJK 判定明细（共 ${gb.length} 个文件）`);
const passStat = new Map();
for (const r of gb) passStat.set(r.pass, (passStat.get(r.pass) || 0) + 1);
[...passStat.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  候选链: ${k}`));
console.log(`  → GBK 可无损回环: ${gb.filter((r) => r.pass.split("|").includes("GBK")).length}`);
console.log(`  → 只有 GB18030 能回环（含 4 字节扩展区字符）: ${anomalies.gb18030Only.length}`);
console.log(`  → 歧义（多候选同时通过）: ${anomalies.ambiguous.length}`);

console.log(`\n关键风险面：GBK 树里混入的「合法 UTF-8 且含非 ASCII」文件（§2 缺陷1 的毁数据场景）= ${anomalies.utf8InGbTree.length}`);
anomalies.utf8InGbTree.slice(0, listUnknown ? 99999 : 15).forEach((f) => console.log(`    ${f}`));
if (anomalies.utf8InGbTree.length > 15 && !listUnknown) console.log(`    ... 共 ${anomalies.utf8InGbTree.length} 个，用 --list-unknown 全列`);
console.log(`\nUTF-8 BOM 文件: ${anomalies.bom.length}`);
anomalies.bom.slice(0, 10).forEach((f) => console.log(`    ${f}`));
console.log(`\nunknown（既非合法 UTF-8，也不能被任何候选无损回环 —— 写入必须拒绝）: ${anomalies.unknown.length}`);
anomalies.unknown.slice(0, 15).forEach(([f, sz]) => console.log(`    ${f} (${sz}B)`));
if (anomalies.oversize.length) console.log(`\noversize(>${maxBytes / 1048576}MB，未判定): ${anomalies.oversize.length}`);

if (outCsv) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  fs.writeFileSync(outCsv, ["file,ext,kind,chosen,candidates,size,eol", ...rows.map((r) => [esc(r.rel), r.ext, r.kind, r.enc, esc(r.pass), r.size, r.eol].join(","))].join("\n"), "utf-8");
  console.log(`\nCSV 明细已写出: ${outCsv}（${rows.length} 行）`);
}
