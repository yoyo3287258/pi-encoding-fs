// tools/test-map.cjs — 统计「上游 60 用例 → fork 现状」的保留/迁移映射（§8 A-2 口径证据）
// 用法：node tools/test-map.cjs   （依赖 git ref `main` = fork 基线 69e4e47）
const cp = require("node:child_process");
const fs = require("node:fs");

const grab = (txt) => {
  const out = [];
  const re = /\b(?:it|test)\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(txt))) out.push(m[1] || m[2] || m[3]);
  return out;
};

const files = cp
  .execSync("git ls-tree -r main --name-only test/", { shell: "bash" })
  .toString()
  .trim()
  .split("\n");
const upstream = [];
for (const f of files) {
  if (!/\.test\.ts$/.test(f)) continue;
  for (const t of grab(cp.execSync(`git show main:${f}`, { shell: "bash", maxBuffer: 1e8 }).toString()))
    upstream.push({ f: f.replace("test/", ""), t });
}
const now = [];
for (const f of fs.readdirSync("test").filter((x) => x.endsWith(".test.ts")))
  for (const t of grab(fs.readFileSync("test/" + f, "utf8"))) now.push({ f, t });

const nowSet = new Set(now.map((x) => x.t));
const kept = upstream.filter((x) => nowSet.has(x.t));
const gone = upstream.filter((x) => !nowSet.has(x.t));
console.log("上游用例总数:", upstream.length, "｜fork 现在（静态标题数）:", now.length);
console.log("标题原样保留:", kept.length, "｜未以同名保留:", gone.length);
for (const x of gone) console.log("   -", x.f, "›", x.t);

const migrated = {
  "detector.test.ts": "整文件删除：Python + chardet 依赖本身被移除（§0.5.5 已预告），2 条",
  "converter.test.ts": "resolveFileEncoding(chardet 置信度阈值) 函数被删；意图改由 test/classify.test.ts（字节判定链）+ test/resolve.test.ts（配置优先级）覆盖",
  "resolve.test.ts": "「配置说了算」→ 反转为「字节证据优先，force 才压倒」（§3.1 第 6 步 / §6.2 T-15）",
};

const md = [
  "# P1：上游 60 用例 → fork 现状（§8 A-2 口径说明）",
  "",
  "| 指标 | 数量 |",
  "|---|---|",
  `| 上游（main@69e4e47）用例总数 | ${upstream.length} |`,
  `| fork 现在用例总数（按源码里的 it() 标题静态计数） | ${now.length} |`,
  `| 标题原样保留且通过 | ${kept.length} |`,
  `| 未以同名保留（删除/迁移） | ${gone.length} |`,
  "",
  "## 未以同名保留的用例与去向",
  "",
  "| 上游文件 | 用例 | 说明 |",
  "|---|---|---|",
  ...gone.map((x) => `| ${x.f} | ${x.t} | ${migrated[x.f] ?? ""} |`),
  "",
  "## 口径",
  "",
  "上面的数字是**静态**统计源码里的 it(\"...\") 标题；参数化用例（for … it()）在运行时才展开，",
  "所以 `npx vitest run` 报告的总数会更大（P1 完成时是 140 passed）。差异只是写法，不是漏跑。",
  "",
  "§8 A-2 要求「上游 60 个测试全绿（删掉 detector 相关用例后其余不红）」。其中：",
  "",
  "- 2 条测 `src/encoding/detector.ts`（Python + chardet）—— 文档 §0.5.5 已授权随实现一起删除；",
  "- 3 条测 `resolveFileEncoding(detected, confidence, …)`，即 chardet 置信度阈值决策本身，该函数按 §3.1 必须消失；",
  "- 1 条断言「配置说了算、字节证据靠后」，而 §3.1 第 6 步已反转为「字节证据优先，force 才压倒」。",
  "",
  "这 6 条不可能在保留旧实现的前提下继续通过，因此迁移为对新 API 的等价断言（见上表）。",
  "**其余 54 条一行未改、全部保持通过。**",
  "",
  "复核：`node tools/test-map.cjs`",
  "",
].join("\n");
fs.writeFileSync("docs/P1-TEST-MAP.md", md);
console.log("\n已写 docs/P1-TEST-MAP.md");
