# P2 实现说明（§3.3 三道硬闸门接入写链路）

分支 `feat/deterministic-classify`。基线：P1（`717b5d5`）。验证：`tsc --noEmit` 干净，
`npx vitest run` → **14 files / 176 tests 全绿**。

## 1. 交付内容

| 位置 | 内容 |
|---|---|
| `src/operations.ts` | 写链路重写：闸门 1 → 行尾恢复 → 编码 → 补 BOM → 原子替换 → 写后回读自校验 → 失败回滚 |
| `src/operations.ts` | `WriteSeam` 注入点（`writeBytes`）：回滚路径可测；默认 `atomicReplace`（同目录临时文件 + fsync + rename） |
| `src/encoding/converter.ts` | `escapeUnmappable()`：不可映射码点 → Java `\uXXXX`（非 BMP 走代理对两次转义） |
| `src/config.ts` | `ResolvedConfig.writeIntent` + `override.encoding` 语义定稿（见 §3.1） |
| `src/resolve.ts` | 分支⑧：已判定编码的文件默认**保持自身编码**；闸门 3 拒写信息点名命中的 override pattern |
| `test/gates.test.ts` | 12 条：T-5 三档策略、闸门 2 回滚三分支、闸门 3 端到端（含 T-6 缺陷 4 现场） |
| `test/e2e-oawssms.test.ts` | 10 条：真实工程**影子树**端到端（A-3/A-6/A-7/A-9 + P2.1 回归），CI 自动跳过 |
| `test/perf/a7-perf.test.ts` | A-7 延迟（合成 300 文件） |
| `docs/CONFIG-GUIDE.md`、`examples/*.jsonc` | 用法指南与模板（`D:\temp\OAWSSMS\.encoding-converter.json` 已按此落地） |

## 2. 执行顺序为什么是这样

`unmappable` 的三种策略都会改变"最终要落盘的文本/编码"（`escape` 改写文本、`drop-to-gb18030`
换目标编码），因此必须发生在 `encodeFromUtf8()` 与行尾恢复之前；而闸门 3 的 `plan.reject`
在决策层就已返回，最先执行：

**闸门 3（决策层）→ 闸门 1（文本/编码修正）→ 行尾恢复 → 编码 → 补 BOM → 闸门 2（落盘 + 回读）**

## 3. 本轮新增/修正的设计决定

### 3.1 写目标到底由谁决定（P2.1，本轮最重要的修正）

**发现过程**（都是真实工程跑出来的，不是假想的）：

1. 第一版语义（P1）：根 `writeEncoding` 决定一切 → 结果 `{pattern:"conf/tplt/**", encoding:"UTF-8"}`
   目录里那个纯 ASCII 的 `velocity.properties`，**写出去是 GBK 字节**。声明 UTF-8 的目录里冒出 GBK 文件。
2. 改成"override.encoding 也决定写目标"之后，影子树又跑出反例：`WebContent/MobileSSOA/**`
   声明 UTF-8，但里面实测混着 **18 个非 UTF-8 遗留文本**（`css/*.css`、`salesReport/**/chunk-vendors.*.js`）
   —— 新语义把它们全部变成"闸门 3 拒写"，即 1.4% 的文件不可编辑。

**定稿规则**：默认**不改变任何已存在文件的编码**，转码必须是用户显式要求。
"显式要求"的形式化 = 该作用域合并后的 `writeEncoding` 与该作用域读编码**不同**
（`ResolvedConfig.writeIntent`；只照抄默认值不算意图）。

| 磁盘现状 | 无改写意图 | 有改写意图 |
|---|---|---|
| 新建 / 纯 ASCII / `force` 不可判定 | 作用域读声明（`override.encoding` > 根 `writeEncoding` > 根 `sourceEncoding`） | `writeEncoding` |
| 判定 cjk（GBK/GB18030/Big5…） | **保持判定出的编码**（写回逐字节不变） | 按 `writeEncoding`，装不下 → 闸门 3 拒 |
| 判定 UTF-8 / UTF-8+BOM | 保持 UTF-8（`protectUtf8`） | 仍保持，除非 `force`/`protectUtf8:false`（警告） |
| 判定 UTF-16 | 保持 + 一定补 BOM | `force` 才转 |

两个方向都由测试钉住：
- `test/resolve.test.ts › override.encoding 与根 writeEncoding 的优先级（P2 定稿）`（含"只有显式改写意图才转写目标编码"）
- `test/e2e-oawssms.test.ts › P2.1 回归：声明 UTF-8 的目录里混着的非 UTF-8 文件`（真实文件）

副作用（正面）：`{sourceEncoding:"GBK"}` 单行配置下，一个被判定成 Big5 的 txt 现在**按 Big5 写回**，
而 P2.1 之前会因"目标 GBK 装不下"被拒 —— 少了一类误报。

### 3.2 无配置目录的写不走原子替换

透传路径（`plan.encoding === null`）继续用 `writeFile(abs, content, "utf-8")`，与 pi 内置行为逐字节一致
（§8 A-1），也保持"就地截断写"的 inode/符号链接语义。只有本扩展真的转码时才 `atomicReplace`。

**已知副作用**（进 README）：转码写替换 inode → 硬链接/符号链接会断链；SVN 只看内容哈希，不受影响。

### 3.3 回读自校验比文档最小实现更严

文档只要求「字节回读 → 判定 == 期望 → 解码 == 期望文本」。实现额外做了：

- **字节全等比较**（`Buffer.compare`）：能抓"同一瞬间另一个进程也写了这个文件"；
- **BOM 长度由编码函数显式返回**，不靠嗅探 —— GBK 内容完全可能以 `FF FE` 开头（合法 GBK 字对），
  嗅探会把它当成 UTF-16LE BOM 并造成假失败（这个坑在 UTF-8-BOM 用例里真的炸过一次）。

失败三分支都有测试：字节不一致 / 判定不符 / 文本不一致 → 分别回滚写前内容或删半成品；
`verifyWrite:false` 时同一注入口**不再报错**，反向证明拦人的确实是闸门。

### 3.4 「已被前人毁掉」的文件不拒写（前提是不再叠加损伤）

原以为 A-6 要断言"28 个受损文件的写必须被拒"，影子树直接打脸：采到的受损文件判定是 **utf8**
（U+FFFD 是以 UTF-8 形式躺在磁盘上的），目标 UTF-8 能无损表示 U+FFFD → 写回逐字节相等 → 拒了是误报。

A-6 因此改写成一条更强的一般不变量：

> 对任何采到的文件：**写要么逐字节无损，要么被闸门响亮拒绝**；绝不允许"写成功但字节变了且没报错"。

只有当目标编码装不下 U+FFFD（典型：`force` 成 GBK 后写回乱码文本）才拒 —— 由
`test/gates.test.ts`（U+FFFD 分支）钉住。**本扩展不修复历史损伤，只保证不再新增。**

### 3.5 读侧 warning 的呈现约束（不变，P3 落地）

追加到 read 结果的提示行只能出现在"写入本来就会被拒"的文件上（pi 的 `edit` 把 readFile 文本当基线，
普通追加提示会被写回磁盘 = 新污染）。其余提示走 `plan.warnings` → P3 的 `ctx.ui.notify()` /
§5.2 条件性系统提示。本轮新增的"保持自身编码、不转码"警告也遵循此约束（只进 `warnings`）。

## 4. 实测证据（可复现）

```
$ npx vitest run
 Test Files  14 passed (14)
      Tests  176 passed (176)

$ npx vitest run test/e2e-oawssms.test.ts          # 真实工程影子树（CI 上整文件跳过）
采样：扫了 7157 个文本文件 → 影子树 164 个（ascii-java:40 gbk-java:40 utf8-java:20
      utf8-jsp:20 gbk-jsp:12 properties:10 damaged:6 other-text:10 utf8-dir-gbk-file:6）
读→写幂等：164 个真实文件，不一致 0 个                     ← A-3
受损文件 9 个：无损写回 9，闸门拒写 0，违规 0                ← A-6
UTF-8 保护：43 个（其中 0 个 BOM 需还原）                    ← 缺陷 1 的反面
GBK java：40 个，目标非 GBK 的 0 个                          ← Big5/EUC-KR 误判 0
遗留非 UTF-8 文件 3 个：全部保持自身编码可写                 ← P2.1 回归
100 个真实 java（12.3KB）：首次 read 附加 1.09ms｜缓存后 0.02ms｜闸门全开 write 8.26ms   ← A-7
采样内 GBK java 行尾：CRLF 40 / LF 0 / 混用 0                ← 与 §11 画像一致
```

合成树（`test/perf/a7-perf.test.ts`）：300 对「读+改+写」8.7KB GBK → **3.69ms/对**（单独运行）；
1MB GBK：read 22ms（含判定，无缓存 20ms）、带闸门 write 82ms。

**延迟口径说明**：A-7 约束的是"首次 read 的**附加**延迟 <5ms"，实测 1.09–1.36ms。
绝对耗时随并行负载波动（合成用例全套并行时 3.69→10.71ms/对），所以两个 perf 用例的断言阈值
放宽到 10ms/60ms，严格数字以本文件记录的单次运行为准。

配置就地验证（只读，不写真实工作副本）：从 `D:/temp/OAWSSMS` 内部路径向上找配置 →
`configDir=D:/temp/OAWSSMS`、`warnings=[]`；`.java`(GBK) 读写一致、`.properties` → `kind=config
ISO-8859-1`、`MobileSSOA/index.html` → UTF-8、`conf/tplt/velocity.properties` → ASCII 走 UTF-8 目标。

> 所有写操作只发生在临时影子树里，**真实 SVN 工作副本零改动**。

## 5. 遗留（下一步 P3）

- 闸门 1 的 `escape`/`drop-to-gb18030` 说明、以及所有 `plan.warnings`，还没有呈现给模型的通道；
  → P3 用 `ctx.ui.notify()`（pi 0.84.3 提供 `select/confirm/input/notify`）+ §5.2 条件性系统提示。
- `src/grep.ts` 仍读 v1 配置键；`edit-preview.ts` 未复用 `classifyBuffer` → P3。
- T-8/T-9（无配置目录逐字节透传对照）、T-12（并发写同一文件）、T-1/T-15 grep 侧 → P3。
- 18 个 MobileSSOA 遗留文件的**真实编码**（GBK 还是 Latin-1）没定论 —— 不阻塞（保持自身编码即可），
  但值得在 P4 README 里作为"为什么不做批量猜测式转码"的实例。
