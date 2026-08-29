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
//   node tools/scan-encoding.mjs <root> --init [--force]   # 按画像写出 .encoding-converter.json
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
const doInit = !!flag("init", false);
const forceInit = !!flag("force", false);
const dryRun = !!flag("dry-run", false);
const damagedOnly = !!flag("damaged", false);

/* 参数校验：拼错或漏了 `--` 必须报错，不能静默跑成另一个功能。
 * 真实踩过的坑：`scan-encoding.mjs . init`（少两个减号）被当成普通画像跑完，
 * 用户以为生成了配置 —— 比报错危险得多。 */
const BOOL_FLAGS = new Set(["list-unknown", "init", "force", "dry-run", "damaged"]);
const VALUE_FLAGS = new Set(["ext", "out", "max-mb"]);
(() => {
  const known = new Set([...BOOL_FLAGS, ...VALUE_FLAGS]);
  const args = argv.slice(argv[0] && !argv[0].startsWith("--") ? 1 : 0);
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!known.has(name)) {
        const near = [...known].find((k) => k.startsWith(name.slice(0, 3)));
        problems.push(`未知参数 ${a}${near ? `（是不是想写 --${near}？）` : ""}`);
        continue;
      }
      if (VALUE_FLAGS.has(name)) i++; // 这个开关带值，跳过值
    } else if (known.has(a)) {
      problems.push(`参数 ${a} 缺少前缀：请写 --${a}`);
    } else {
      problems.push(`多余的位置参数 ${a}（本工具只接受一个目录参数 + --开关）`);
    }
  }
  if (problems.length) {
    console.error("❌ " + problems.join("\n❌ "));
    console.error(
      "用法：node tools/scan-encoding.mjs <目录> [--init [--force]] [--dry-run] [--damaged] [--out report.csv] [--ext java,jsp] [--max-mb 50] [--list-unknown]",
    );
    process.exit(2);
  }
})();

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
// --init 在没声明时取“能覆盖全部观测字节的最窄一个”，但 **GB2312 不参与推断**：
// 它是 GBK 的真子集，而 GBK 对 GB2312 字节向后兼容（同样的字同样的码），
// 拿 GB2312 当根编码读不会错、写也不会变，唯一的后果是“GBK 里有、GB2312 里没有的字”
// 被闸门 1 白白拒写 —— 零收益只多报错。真实世界的项目声明几乎都是 GBK 而不是 GB2312。
const FAMILY_ORDER = ["GBK", "Big5", "Shift_JIS", "EUC-KR", "EUC-JP", "GB18030"];

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
/** 已经被「UTF-8 硬编码工具」毁过的文件：内容里含有 U+FFFD 或它的 GBK 形态「锟斤拷」。 */
const damaged = [];
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
    // 历史损坏检测：按判定出的编码解码后数 U+FFFD（包括 GBK 解出的「锟斤拷」字样）
    let fffd = 0;
    if (c.kind !== "binary" && c.kind !== "unknown" && c.kind !== "ascii") {
      try {
        const text = c.kind === "utf8" || c.kind === "utf8-bom" ? b.toString("utf-8") : iconv.decode(b, c.enc);
        fffd = (text.match(/\ufffd/g) || []).length;
        if (/锟斤拷/.test(text)) fffd = Math.max(fffd, 1);
      } catch {
        /* 忽略 */
      }
    }
    const rel = path.relative(root, p).replace(/\\/g, "/");
    // 本扩展自己的配置文件不计入“已毁掉”：它的注释里字面含有 U+FFFD /「锟斤拷」这些标记字样
    // （生成时就是为了告诉人“这里防的是什么”），会被上面的检测命中 —— 纯误报，
    // 实测在 OAWSSMS 上工具把自己生成的配置标成了受损文件。
    if (fffd && !/(^|\/)\.encoding-converter\.json(\.|$)/.test(rel)) damaged.push([rel, c.kind, fffd]);
    rows.push({ rel, ext, kind: c.kind, enc: c.enc, pass: c.pass.join("|"), size: st.size, eol: lineEndingOf(b), fffd });
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

/* --damaged：只输出“已被前人毁掉”的清单（文档承诺过的聚焦输出），跳过画像表格 */
if (damagedOnly) {
  damaged.sort((a, b) => b[2] - a[2]);
  const totalFffd = damaged.reduce((s, d) => s + d[2], 0);
  console.log(`扫描根目录: ${root}`);
  console.log(`实际判定文件数: ${scanned}（跳过已知二进制扩展名 ${skippedBinary} 个）`);
  console.log(`\n❗ 已经被毁的文件（内容里已含 U+FFFD / 「锟斤拷」）：${damaged.length} 个，共 ${totalFffd} 处替换字符`);
  console.log("   这类损坏不可逆，本扩展只能防止新的损坏发生；需要回滚的请查 SVN/Git 历史。");
  if (!damaged.length) console.log("    （无）");
  else damaged.forEach(([f, kind, n]) => console.log(`    ${String(n).padStart(4)} 处  [${kind}]  ${f}`));
  process.exit(0);
}

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

damaged.sort((a, b) => b[2] - a[2]);
const totalFffd = damaged.reduce((a, d) => a + d[2], 0);
console.log(`\n❗ 已经被毁的文件（内容里已含 U+FFFD / 「锟斤拷」）：${damaged.length} 个，共 ${totalFffd} 处替换字符`);
console.log("   这类损坏不可逆，本扩展只能防止新的损坏发生；需要回滚的请查 SVN 历史。");
damaged.slice(0, listUnknown ? 99999 : 20).forEach(([f, kind, n]) => console.log(`    ${String(n).padStart(4)} 处  [${kind}]  ${f}`));
if (damaged.length > 20 && !listUnknown) console.log(`    ... 共 ${damaged.length} 个，用 --list-unknown 全列`);

if (outCsv) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  fs.writeFileSync(
    outCsv,
    ["file,ext,kind,chosen,candidates,size,eol,fffd", ...rows.map((r) => [esc(r.rel), r.ext, r.kind, r.enc, esc(r.pass), r.size, r.eol, r.fffd].join(","))].join("\n"),
    "utf-8",
  );
  console.log(`\nCSV 明细已写出: ${outCsv}（${rows.length} 行）`);
}

/* -------------------------------------------------------------------------- */
/* --init：把上面的画像写成一份可用的 .encoding-converter.json                    */
/* -------------------------------------------------------------------------- */
// 设计原则：
//   1) 依据优先级 = 工程里的**声明**（IDE/构建配置）> 字节事实（唯一候选）> 超集兜底。
//      因为中文文本在 GB18030/GBK/GB2312/Big5/EUC-KR 下往往**全部**能无损回环（性质 P-3），
//      字节投票在真实工程里基本总是歧义（实测 OAWSSMS：3114/3114 个传统编码文件全歧义），
//      这时候靠字节猜出来的 GB18030 会写出 Eclipse/GBK 读不懂的 4 字节序列。
//   2) 推不出来的东西写进注释提醒人，不自作主张改语义（那是 §9 的路线决策）。
//   3) 绝不默默覆盖已有配置。
if (doInit) initFromProfile();

/** 把声明里的各种写法归一到我们用的规范名（iconv-lite **没有**公开的 getEncoding，
 *  别指望它帮你规范化——这是实测坳过的坑） */
function normEnc(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[\s_]/g, "");
  const map = {
    utf8: "UTF-8", "utf-8": "UTF-8", u8: "UTF-8",
    gbk: "GBK", cp936: "GBK", "windows-936": "GBK", ms936: "GBK", chinese: "GBK", "gb-cp936": "GBK",
    gb2312: "GB2312", "euc-cn": "GB2312", "gb_2312-80": "GB2312", gbkgb2312: "GB2312",
    gb18030: "GB18030", cp54936: "GB18030",
    big5: "Big5", cp950: "Big5", "big5hkscs": "Big5_HKSCS",
    "shift-jis": "Shift_JIS", shiftjis: "Shift_JIS", sjis: "Shift_JIS", cp932: "Shift_JIS", ms932: "Shift_JIS",
    "euc-kr": "EUC-KR", ksc5601: "EUC-KR", cp949: "EUC-KR", uhc: "EUC-KR",
    "euc-jp": "EUC-JP", "ujis": "EUC-JP", cp51932: "EUC-JP",
    "iso-8859-1": "ISO-8859-1", latin1: "ISO-8859-1", "8859-1": "ISO-8859-1", l1: "ISO-8859-1", cp819: "ISO-8859-1",
    // 注意：cp1252 与 ISO-8859-1 **不是**同一编码（0x80-0x9F 区间不同），不能归一到一起
    cp1252: "windows-1252", "windows-1252": "windows-1252", "x-cp1252": "windows-1252",
    utf16le: "UTF-16LE", unicode: "UTF-16LE", "utf-16le": "UTF-16LE",
    utf16be: "UTF-16BE", "utf-16be": "UTF-16BE",
    ascii: "ASCII", "us-ascii": "ASCII", ansi_x3_4_1968: "ASCII",
  };
  const hit = map[k];
  if (hit) {
    try {
      return iconv.encodingExists(hit) ? hit : null;
    } catch {
      return null;
    }
  }
  try {
    return iconv.encodingExists(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 自己走一遍找声明文件，**不走分类结果**：否则 --ext 过滤或 .idea 被跳过会静默漏掉声明 */
function findDeclFiles(dir, depth, acc) {
  if (depth > 4 || acc.length > 200) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === ".svn" || e.name === "node_modules" || e.name === "target" || e.name === "build" || e.name === "dist") continue;
      findDeclFiles(p, depth + 1, acc);
    } else if (
      /^(org\.eclipse\.core\.resources\.prefs|encodings\.xml|pom\.xml|build\.gradle|build\.gradle\.kts|\.editorconfig|\.gitattributes)$/.test(e.name)
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/** 从工程里的声明文件提编码事实（Eclipse / IDEA / Maven / Gradle / editorconfig / gitattributes） */
function collectDeclarations() {
  const out = [];
  for (const abs of findDeclFiles(root, 0, [])) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (process.env.SCAN_DEBUG) console.error("[decl] 文件:", rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size > 400_000) continue;
    let txt;
    try {
      txt = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const projDir = path.posix.dirname(path.posix.dirname(rel)); // <工程>/.settings/x.prefs → <工程>
    const base = projDir === "." || projDir === ".." ? "" : projDir;
    const toRoot = (p) => (base ? `${base}/${p}` : p);
    // 工作区绝对路径 vs 工程相对路径：看哪个真存在
    const fixPath = (p) => {
      const absPath = p.replace(/^\/+/, "");
      const candA = toRoot(absPath);
      const candB = absPath;
      if (fs.existsSync(path.join(root, candA))) return candA;
      if (fs.existsSync(path.join(root, candB))) return candB;
      return candA;
    };
    if (rel.endsWith("org.eclipse.core.resources.prefs")) {
      if (process.env.SCAN_DEBUG) console.error("[decl]   内容:", JSON.stringify(txt.slice(0, 80)));
      for (const line of txt.split(/\r?\n/)) {
        const m = /^encoding(\/\/.+|\/[^/=]+|\/<project>)=\s*([^\s]+)\s*$/.exec(line.trim());
        if (!m) continue;
        const enc = normEnc(m[2]); // 注：这个正则只有 2 个捕获组（1=路径、2=编码），写成 m[3] 会静默丢掉全部声明
        if (!enc) {
          if (process.env.SCAN_DEBUG) console.error("[decl]   跳过（编码名不认识）:", line.trim());
          continue;
        }
        const key = m[1];
        if (key.endsWith("<project>")) {
          out.push({ scope: base || ".", encoding: enc, source: `${rel}: ${line.trim()}`, kind: "root" });
        } else {
          const p = fixPath(key.replace(/^\/\//, "/").replace(/^\//, ""));
          out.push({ scope: p, encoding: enc, source: `${rel}: ${line.trim()}`, kind: "path" });
        }
      }
    } else if (rel.endsWith("encodings.xml")) {
      for (const m of txt.matchAll(/<encoding\s+package="([^"]*)"[^>]*charset="([^"]+)"/g)) {
        const enc = normEnc(m[2]);
        if (enc) out.push({ scope: m[1] || ".", encoding: enc, source: `${rel}: package=${m[1] || "(default)"}`, kind: m[1] ? "path" : "root" });
      }
      for (const m of txt.matchAll(/<component name="ProjectEncodings"[^>]*encoding="([^"]+)"/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: 工程默认`, kind: "root" });
      }
    } else if (rel.endsWith("pom.xml")) {
      for (const m of txt.matchAll(/<(?:project\.)?build\.sourceEncoding>([^<]+)</g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: <${m[0].slice(1, -1).split(">")[0]}>`, kind: "root" });
      }
    } else if (/build\.gradle(\.kts)?$/.test(rel)) {
      for (const m of txt.matchAll(/(?:encoding|charset)\s*[=(]?\s*["']([A-Za-z0-9_.-]+)["']/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: ${m[0].trim()}`, kind: "root" });
      }
    } else if (rel.endsWith(".editorconfig")) {
      for (const m of txt.matchAll(/^charset\s*=\s*([a-z0-9-]+)\s*$/gim)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: charset=${m[1]}`, kind: "root" });
      }
    } else if (rel.endsWith(".gitattributes")) {
      for (const m of txt.matchAll(/working-tree-encoding\s*=\s*([A-Za-z0-9_.-]+)/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: "(gitattributes)", encoding: enc, source: `${rel}: working-tree-encoding=${m[1]}`, kind: "git" });
      }
    }
  }
  return out.map((d) => {
    if (process.env.SCAN_DEBUG) console.error("[decl] ", d.kind, d.scope, d.encoding, "←", d.source);
    return d;
  });
}

function initFromProfile() {
  const target = path.join(root, ".encoding-converter.json");
  // --dry-run 不碰磁盘 → 已有配置也允许只看建议
  if (!dryRun && fs.existsSync(target) && !forceInit) {
    console.log(`\n❌ 已存在 ${target}，**未改动**（覆盖请加 --force；只看建议加 --dry-run）。`);
    console.log("   想看当前配置下的实际生效结果：跑不带 --init 的画像，或看 docs/CONFIG-GUIDE.md。");
    process.exitCode = 1;
    return;
  }
  const cjkRows = rows.filter((r) => r.kind === "cjk");
  const utf8Rows = rows.filter((r) => r.kind === "utf8" || r.kind === "utf8-bom");
  const asciiRows = rows.filter((r) => r.kind === "ascii");
  const unknownRows = rows.filter((r) => r.kind === "unknown");
  const ambiguous = cjkRows.filter((r) => r.pass.split("|").length > 1);
  const sole = new Map();
  for (const r of cjkRows) {
    if (r.pass.split("|").length !== 1) continue;
    sole.set(r.enc, (sole.get(r.enc) || 0) + 1);
  }
  const ranked = [...sole.entries()].sort((a, b) => b[1] - a[1] || CANDIDATES.indexOf(a[0]) - CANDIDATES.indexOf(b[0]));
  const decls = collectDeclarations();
  const rootDecl = decls.filter((d) => d.kind === "root");
  const declVotes = new Map();
  for (const d of rootDecl) declVotes.set(d.encoding, (declVotes.get(d.encoding) || 0) + 1);
  const declTop = [...declVotes.entries()].sort((a, b) => b[1] - a[1])[0];

  let legacy, basis;
  // 字节上能覆盖**全部**观测到的传统编码文件的最窄编码（窄 = 对同事的旧工具链更安全）。
  // 不需要重读文件：每个 cjk 行的 pass 候选链已经是“能无损回环”的集合。
  // 取窄而不取超集的理由：选 GB18030 会静默允许写出 4 字节序列，
  // 而 Eclipse/老 JDK 按 GBK 读那些字节就是乱码；选窄编码则是往
  // “写不下就拒（闸门 1）”这个安全方向偏。
  const narrowest = FAMILY_ORDER.find((e) => cjkRows.length > 0 && cjkRows.every((r) => r.pass.split("|").includes(e)));
  const tooNarrow = new Map();
  if (narrowest) {
    for (const e of FAMILY_ORDER) {
      if (e === narrowest) break;
      tooNarrow.set(e, cjkRows.filter((r) => !r.pass.split("|").includes(e)).length);
    }
  }
  if (declTop) {
    legacy = declTop[0];
    basis = `工程声明：${rootDecl.filter((d) => d.encoding === legacy).map((d) => d.source).join("；")}`;
  } else if (ranked.length) {
    legacy = ranked[0][0];
    basis = `字节事实：“${ranked[0][0]} 可无损回环且候选唯一”的文件有 ${ranked[0][1]} 个`;
  } else if (narrowest) {
    legacy = narrowest;
    const why = [...tooNarrow.entries()].map(([e, n]) => `${e} 差 ${n} 个`).join("、");
    basis = `没有声明、且字节全部歧义 → 取能覆盖全部 ${cjkRows.length} 个传统编码文件的**最窄**候选 ${narrowest}${why ? `（更窄的：${why}）` : ""}`;
  } else if (cjkRows.length) {
    legacy = "GB18030";
    basis = "没有声明；候选集里没有一个编码能覆盖全部文件（树里可能混着不同语系的编码）→ 只能取超集 GB18030";
  } else {
    legacy = "UTF-8";
    basis = "没发现任何传统编码文本，整树按 UTF-8 看待";
  }

  /* override：① 工程里的窄范围声明直接搬过来；② 没声明时，找“整块是 UTF-8”的子目录 */
  const overrides = [];
  const notes = [];
  const push = (pattern, encoding, source) => {
    if (overrides.length >= 40) return;
    if (overrides.some((o) => o.pattern === pattern && o.encoding === encoding)) return;
    overrides.push({ pattern, encoding });
    if (source) notes.push(`override ${pattern} → ${encoding}（依据：${source}）`);
  };
  /** 该范围内“字节事实与声明不符”的比例；用来判断一条声明值不值得信 */
  const conflictRatio = (d) => {
    const dir = d.kind === "root" ? "" : d.scope;
    const inScope = rows.filter(
      (r) => (r.kind === "cjk" || r.kind === "utf8") && (!dir || r.rel === dir || r.rel.startsWith(dir + "/")),
    );
    if (!inScope.length) return null;
    const declaredUtf8 = /^UTF-8$/i.test(d.encoding);
    const wrong = declaredUtf8 ? inScope.filter((r) => r.kind === "cjk") : inScope.filter((r) => r.kind === "utf8");
    return { total: inScope.length, wrong: wrong.length, sample: wrong[0] ? wrong[0].rel : "", inScope };
  };
  for (const d of decls.filter((x) => x.kind === "path")) {
    const isDir = !/\.[A-Za-z0-9]{1,8}$/.test(d.scope); // 扩展名 1~8 位（.java/.properties…）；写 \.[A-Za-z0-9]$ 会把所有文件误判成目录
    const c = conflictRatio(d);
    if (c && c.wrong >= c.total * 0.5) {
      // 自己的分析说这条声明不可靠 → 不写进 override，只报给人看
      notes.push(`❗ 没采纳声明 ${d.scope} → ${d.encoding}：范围内 ${c.wrong}/${c.total} 个含非 ASCII 文件字节上不是该编码（如 ${c.sample}）。`);
      continue;
    }
    push(isDir ? `${d.scope}/**` : d.scope, d.encoding, d.source);
  }
  /* ② 目录多数推断：根编码不是 UTF-8 时，把“目录内非 ASCII 明显多数是 UTF-8（≥70% 且 ≥8 个）
   *    且与根编码不同”的目录补成 UTF-8 override，只取**最浅**覆盖层（避免 WebContent/** 和它的
   *    每个子目录都重复一条）。老实现有两个毛病：被 `overrides.length < 8` 饿死（声明一多就跳过），
   *    且要求目录里 0 个传统编码文件（WebContent 这种“1965 UTF-8 + 44 GBK”就发不出来）。
   *    新语义 = 按目录内多数文件编码推断（你要的那条），新建/纯 ASCII 文件落这个目录时用多数编码写。 */
  if (legacy !== "UTF-8") {
    const dirCounts = new Map();
    for (const r of rows) {
      if (r.kind === "binary" || r.kind === "empty" || r.kind === "oversize" || r.kind === "unknown") continue;
      const segs = r.rel.split("/");
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join("/");
        if (!dirCounts.has(dir)) dirCounts.set(dir, { utf8: 0, cjk: 0 });
        const c = dirCounts.get(dir);
        if (r.kind === "utf8" || r.kind === "utf8-bom") c.utf8++;
        else if (r.kind === "cjk") c.cjk++;
      }
    }
    const covered = new Set();
    const sorted = [...dirCounts.entries()].sort((a, b) => a[0].split("/").length - b[0].split("/").length);
    for (const [dir, c] of sorted) {
      if (covered.has(dir)) continue;
      const total = c.utf8 + c.cjk;
      if (total < 8) continue;
      if (c.utf8 < c.cjk || c.utf8 / total < 0.7) continue;
      const pattern = `${dir}/**`;
      if (overrides.length >= 60) break;
      push(
        pattern,
        "UTF-8",
        `该目录 ${c.utf8} 个 UTF-8、${c.cjk} 个传统编码，非 ASCII 中 UTF-8 占 ${Math.round((c.utf8 * 100) / total)}%`,
      );
      for (const sub of dirCounts.keys()) {
        if (sub.startsWith(dir + "/")) covered.add(sub);
      }
    }
  }

  /* 声明与字节不符 → 这是最需要人看的东西，必须单列 */
  const conflicts = [];
  for (const d of decls) {
    if (d.kind === "git") continue;
    const c = conflictRatio(d);
    if (!c || !c.wrong || c.wrong < c.inScope.length * 0.5) continue;
    conflicts.push(`${d.source} 声明 ${d.encoding}，但该范围内 ${c.wrong}/${c.total} 个含非 ASCII 文件字节上不是（如 ${c.sample}）`);
  }
  const gitDecl = decls.filter((d) => d.kind === "git");

  const header = [
    `// 由 tools/scan-encoding.mjs ${dryRun ? "--init --dry-run（下面是建议内容）" : "--init"} 生成于 ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    `// 画像：传统编码 ${cjkRows.length}（其中歧义 ${ambiguous.length}）｜含非 ASCII 的 UTF-8 ${utf8Rows.length}｜纯 ASCII ${asciiRows.length}｜unknown ${unknownRows.length}｜已损 ${damaged.length}`,
    `// sourceEncoding = ${legacy}。依据（优先级：工程声明 > 字节事实 > 超集兜底）：${basis}`,
  ];
  if (declTop && ranked.length && ranked[0][0] !== declTop[0]) {
    header.push(`// 注意：字节上“唯一候选”最多的是 ${ranked[0][0]}（${ranked[0][1]} 个），但按优先级采用了工程自己的声明 ${declTop[0]}。`);
  }
  if (!declTop && ranked.length === 0 && cjkRows.length) {
    header.push(
      `// ⚠ 这个 ${legacy} 是从字节推的（没有工程声明可查）：${cjkRows.length} 个传统编码文件全部在多个候选间歧义（中文文本本来就这样，见性质 P-3）。`,
    );
    header.push(
      `//   选它是因为它是**能覆盖全部观测字节的最窄编码**；若你们 IDE/构建脚本里另有声明（Eclipse .settings/org.eclipse.core.resources.prefs、`);
    header.push(`//   pom 的 project.build.sourceEncoding、gradle 的 encoding），声明会优先于上面的推断。`);
  }
  if (ambiguous.length) {
    header.push(`// 歧义：${ambiguous.length} 个文件同时能当 ${[...new Set(ambiguous.flatMap((r) => r.pass.split("|")))].slice(0, 6).join("/")} 回环；字节分不出，由 autoCandidates 顺序决定。`);
  }
  for (const c of conflicts.slice(0, 10)) header.push(`// ❗ 声明与字节不符：${c}`);
  if (conflicts.length > 10) header.push(`// ❗ …另有 ${conflicts.length - 10} 条同类不符，跑不带 --init 的画像 + --out xx.csv 对照。`);
  if (gitDecl.length) {
    header.push(`// 另外检测到 .gitattributes 里的 working-tree-encoding（${gitDecl.map((g) => g.encoding).join(",")}）：`);
    header.push(`//   那是 §9 的路线 C（git 做转码），与本配置是两层机制，共存时请先搞清哪层生效，别两边都转。`);
  }
  if (damaged.length) header.push(`// ❗ 已有 ${damaged.length} 个文件内容里带着 U+FFFD / 「锟斤拷」（历史 damage，不可逆）。本扩展只防新增。`);
  if (unknownRows.length) header.push(`// ❗ ${unknownRows.length} 个文件既不是合法 UTF-8、也不能被任何候选无损回环 → 写它们会被闸门 3 直接拒。`);
  if (utf8Rows.length && legacy !== "UTF-8") header.push(`// 那 ${utf8Rows.length} 个“传统编码树里混着的 UTF-8 文件”即使不写 override，protectUtf8 也会护住不被转码。`);
  const propsCjk = cjkRows.filter((r) => r.ext === "properties").length;
  if (propsCjk) header.push(`// 提示：${propsCjk} 个 .properties 是传统编码。想按 native2ascii 惯例写 \\uXXXX 逸出，见 CONFIG-GUIDE §3.4。`);
  header.push(`// 键参考与写目标语义：docs/CONFIG-GUIDE.md（§2.2）；安装：docs/INSTALL.md。`);

  const cfg = {
    sourceEncoding: legacy,
    writeEncoding: legacy,
    unmappable: "error",
    verifyWrite: true,
    protectUtf8: true,
    readStrategy: "auto",
    transcodeBash: false,
    overrides,
  };
  notes.unshift(`根编码 ${legacy}；写回同一种编码；装不下的字直接拒写；protectUtf8 开启。`);
  notes.push(`共 ${overrides.length} 条 override（${decls.filter((d) => d.kind === "path").length} 条直接搬自工程声明）。`);
  notes.push("transcodeBash 默认关（实验特性）；要开写 true 或 \"auto\"（别写字符串 \"true\"），改完要重启 pi。");
  const text = `${header.join("\n")}\n${JSON.stringify(cfg, null, 2)}\n`;

  if (dryRun) {
    console.log(`\n（--dry-run）建议写入 ${target} 的内容如下，磁盘未动：\n`);
    console.log(text);
    notes.forEach((n) => console.log(`   · ${n}`));
    return;
  }
  fs.writeFileSync(target, text, "utf-8");
  console.log(`\n${fs.existsSync(target) && forceInit ? "✅ 已覆盖" : "✅ 已写出"} ${target}`);
  notes.slice(0, 14).forEach((n) => console.log(`   · ${n}`));
  if (notes.length > 14) console.log(`   · …另有 ${notes.length - 14} 条说明，见配置文件头部注释。`);
  if (conflicts.length) console.log(`   ❗ ${conflicts.length} 条“声明与字节不符”已写进配置头部注释，请先人工确认再提交。`);
  console.log("   下一步：重启 pi（工具注册在启动时定）；以后改其他键不需要重启，只有 transcodeBash 要。");
}
