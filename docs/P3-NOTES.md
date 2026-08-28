# P3 笔记：grep / 系统提示 / edit 预览 / 回显通道（含真实工程活体验收）

需求文档 §5 + §6.2（T-8…T-15）+ §6.3（端到端）+ §8（A-8、A-9）。
分支 `feat/deterministic-classify`，本阶段落在 P2/P2.1（`8dbc698`）之后。

---

## 1. 交付清单

| 位置 | 变更 |
| --- | --- |
| `src/grep.ts` | **重写**。多趟编码搜索 + 逐文件判定信任；无配置整体委托内置（返回 `null`） |
| `src/sysnote.ts` | 新增。§5.2 条件式系统提示（含 `configAppliesTo()` 树扫描） |
| `src/notify.ts` | 新增。闸门/判定提示的进程内容器（`push/drain/clear/notesToSuffix`） |
| `src/resolve.ts` | `ReadPlan.warnings` 补上（P1 遗留：算出来了但没随 plan 返回） |
| `src/operations.ts` | 读/写链路把 `plan.warnings` + 闸门 1 说明寄存给 `notify`；**新增 `withPathLock()`**；`atomicReplace` 加 Windows rename 退避重试；写事务整体串行化 |
| `src/config.ts` | 新增 `findNearestConfigSync()` / `loadConfigInDirSync()`（共用 `dirCache`）、`configGeneration()` |
| `src/edit-preview.ts` | §5.3：预览路由从 `TextDecoder(fatal)` 二分法改为 `classifyBuffer + 配置` |
| `src/index.ts` | `before_agent_start` 改条件注入；新增 `tool_result` 回显；`session_start`/`reload` 清三个缓存 |
| `test/grep.test.ts` | 27 个用例（委托条件、多趟、假阳性/假阴性、确定性排序、`.svn` 排除） |
| `test/sysnote.test.ts` | 新增。A-8 正反证 + 回显通道 + 后缀长度上限 |
| `test/concurrency.test.ts` | 新增。T-12 并发写（3 个用例，含 Windows 真锁场景） |
| `test/edit-preview.test.ts` | 更新 3 个用例到新语义（无配置 → 透传 → 上游预览天然正确） |
| `tools/bench-p3.mjs` | 新增。A-7 真实工程延迟 + grep 趟数开销实测 |

验证：`npx tsc --noEmit` 干净；`npx vitest run` → **16 文件 / 199 用例全绿**。

---

## 2. §5.1 grep：设计决定

1. **无配置 = 整体委托**。`resolveReadPlan()` 对目标树返回 `null`（找不到 `.encoding-converter.json`）时，本工具直接返回 `null`，调用方（`index.ts` 注册的定义）委托 pi 内置实现 —— 不是"我们自己写一遍内置逻辑"。内置的 `ensureTool` 不在包导出面上（exports map 挡住深路径），所以取"复用内置 ToolDefinition 的 `description`/`renderCall`/`renderResult`，只在 execute 里分流"这条路：模型看到的工具描述、终端渲染跟内置逐字一致，零 UX 漂移。
2. **多趟而不是猜一趟**。`buildEncodingPasses()`：UTF-8 永远第一趟；只有 pattern 含非 ASCII 才加第二趟；候选里单字节编码（latin1/cp1252/ISO-8859-1）跳过（字节层面无法与 UTF-8 区分，只会造假的命中）；GB 家族折叠成 `GB18030` 一趟（GB18030 是 GBK/GB2312 超集）；UTF-16 交给 rg 的 BOM 嗅探（实测 rg 自动处理）。
3. **逐文件信任判定，不是全局趟号**。每趟的原始命中，再用**该文件自己的读解码链**（`resolveReadPlan` 同一套规则）解出来，确认 pattern 真的出现在解码文本里才算数。这一步同时修掉两类错误：
   - 假阳性：UTF-8 文件被 GB 趟乱码命中（`createGrepToolDefinition` 早期版本只在 GB 趟后跑一次全量 UTF-8 校验，漏掉了"同文件双趟命中"的情况）。
   - 假阴性：纯 ASCII 的 pattern 在 GBK 文件里被 UTF-8 趟命中（ASCII 是两边共用的字节），但假阳性校验会因为它"不是合法 UTF-8 文本"而误杀 → 现在按文件判定，ASCII 命中在两种编码下都成立，保留。
4. **`--hidden` 必配永久排除 `.git/.svn/.hg/node_modules`**。实测（pi 自带 rg 15.2.0，OAWSSMS 665MB/25079 文件）：`--hidden` 会连 `.git` 一起搜；SVN 工程里 `.svn/pristine` 存着**每个文件每个版本的原文副本**，不排就是重复假阳性（实测同一 pattern：排除后 1 个真命中，不排除 2 个）。注意 **pi 内置 grep 也用 `--hidden` 且没有这些排除**（`dist/core/tools/grep.js:140`），所以在 SVN 工作副本里内置工具本身就会吐 `.svn` 幽灵结果 —— 我们的实现修掉了，且这不是"和内置不一致"，是内置的缺陷。
5. **不传 `--no-ignore`**：保留 rg 默认 `.gitignore`/`.ignore` 行为，跟内置一致（内置也只加 `--hidden`）。
6. **确定性排序**（`path → line → encodingPass`）后按 limit 截断。内置的输出顺序依赖 rg 的并行遍历，同一棵树两次调用顺序可能不同；我们排序后再截断，`limit` 的语义才稳定（测试里踩过一次，已固化成用例）。
7. Windows 细节：**`execFile(rg, args, {cwd})` 不传路径参数时 rg 搜不到任何东西**（实测 EXIT1 vs 带 `.` 的 EXIT0）。我们的实现始终传 `searchPath`，因此不受影响 —— 但这个坑要在文档里留字，任何重写的人都会再踩。

rg 定位顺序：`RG_PATH` 环境变量 → `~/.pi/agent/bin/rg(.exe)`（pi 自带，实测 `C:\Users\yoyo3\.pi\agent\bin\rg.exe`）→ PATH → VS Code ripgrep 包路径。

---

## 3. §5.2 条件式系统提示（修上游"无条件注入"）

`systemNoteFor(cwd)`：
- 先看 `findNearestConfigSync(cwd)`（配置在祖先目录 → 适用于本树）；
- 没有再**有界**向下扫：`SCAN_MAX_DIRS=400`、深度 ≤3、跳过 `node_modules`/`.git`/`.svn`/`target`/`build` 等；
- 都没有 → 返回 `null`，`before_agent_start` 一个字都不加（**A-8**）。

有配置时注入的是**常量** `ENCODING_NOTE`（741 字符，≈190 token，比上游那段更短），内容三条硬事实 + 一条行为要求：按字节确定性判定、UTF-8 受保护、装不下就大声失败、**遇到 `[encoding: UNKNOWN]` 停下来问用户**；**不出现 python/chardet 字样**（不再诱导模型去调 Python）。

> 为什么"常量"和"条件"能共存：条件只决定**注不注入**，注入的文本永远是同一份串。同一个会话里 prompt 前缀稳定，缓存前缀仍然命中；跨项目也不会出现"在没有转换器的树里读到一段讲转换器的系统提示"。

---

## 4. 提示回显通道（P2 遗留问题在这里收口）

P2 时的纠结：闸门 1 的 `escape`/`drop-to-gb18030` 成功提示、配置诊断（`warnings`）要不要贴到 read/edit 结果上？答案是**不能进 `ops.readFile` 的返回内容** —— pi 的 `edit` 拿 `readFile` 的输出当基线文本，任何附加文字都有被当文件内容写回磁盘的风险（这在 P2 早期真实造成过一次 0x3F 污染）。

P3 的做法：
1. `operations` 侧只 `pushEncodingNote(absPath, text)`（进程内 Map，见 `src/notify.ts`），**永远不改字节缓冲区**；
2. `index.ts` 的 `tool_result` 钩子按 `input.path`/`input.file_path` 取出并 `drain`：
   - 全部走 `ctx.ui.notify()`（人在界面上看到）；
   - `read`/`edit`/`write` 且非 `isError` 时，再追加一段 `\n\n[encoding] …` 文本块给模型看（**pi 自己也这么干**：`read` 截断时往 content 里追加 `[Showing lines …]`，`dist/core/tools/read.js:229-247`，所以是有先例的格式，模型知道那是附注不是文件内容）；
   - 长度上限 400 字符、单行、条数超过会合并 —— 防止把上下文撑爆；
   - 闸门**拒绝**的路径（`isError`）不追加，因为异常文本里已经有完整原因和建议，避免重复。

磁盘上永远不可能出现这些文字，这是本节的硬不变量，`test/sysnote.test.ts` 里用"escape 成功写之后磁盘字节里不含 `[encoding]`"钉住。

---

## 5. T-12 并发写在 Windows 上抓到的两个真问题

第一轮 `test/concurrency.test.ts`（20 个并发"读+改+写"同一个 GBK 文件）直接暴露：

1. **`EPERM: operation not permitted, rename '…encfs.tmp' -> 'X.java'`**
   Windows 上目标文件被别的句柄打开时 rename 会失败。修法：`atomicReplace` 对 `EPERM/EACCES/EBUSY/ENOTEMPTY/EDELET` 做退避重试（0/8/16/32/64/128ms），每次重建临时文件。
2. **更要命的是正确性而不只是可用性**：并发写同一文件时，A 的"写后回读自校验"（闸门 2）可能读到 B 刚 rename 上去的字节，于是把 A 的写当成"结果不一致"回滚 —— 而回滚会**覆盖掉 B 的更新**（丢失更新），且报给模型的错误是假的。
   修法：`withPathLock(absPath, fn)`（大小写不敏感的键，Windows/macOS 需要），把**备份 → 落盘 → 回读校验 → 必要时回滚**整段按路径串行化。
   注：pi 自己有 `withFileMutationQueue`（我们复用它的写队列语义），但那是工具 execute 层的队列；我们的校验-回滚是一个跨多次 fs 调用的事务，不能依赖调用方是否上了锁。

三个用例：同文件 20 并发（结束时必是某一次完整写入、仍合法 GBK、无残留临时文件）、不同文件并发互不干扰、闸门 1 抛错期间不断 `readFileSync` 采样（任何时刻长度只有原文件长度一种值 → 无中间态）。

---

## 6. §6.3 真实工程活体验收（`D:/temp/OAWSSMS`，真 `pi` 真模型）

安装：`cd D:/temp/OAWSSMS && pi install D:/develop/pi/pi-encoding-fs -l` → 生成 `.pi/settings.json`（`packages: ["../../../develop/pi/pi-encoding-fs"]`，引用而非拷贝）。
运行：`pi -p --approve --no-session …`（`--approve` 让非交互模式吃项目级配置）。

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 改 GBK java（`src/wsa/…/ISignService.java`，161B）注释里的时间 | **161→161 字节**、无 BOM、无裸 `0x3F`、**仍不是合法 UTF-8**（=还是 GBK）、CRLF 8 行/裸 LF 0、**只有第 5 行不同**、其余逐字节完好。缺陷 1 反证 |
| 2 | 真实 UTF-8 且带历史损坏（`FeeowntypeCashitemService.java`，87 个 U+FFFD） | 根配置 `sourceEncoding/writeEncoding=GBK` 下**仍按 UTF-8 写回**（UTF-8 保护 + P2.1 写目标=自身编码）；1 行差异；U+FFFD 从 87→72（被改的那行本身就是乱码，替换后更干净，不是新增损坏）；模型自己在回答里说明"该文件实为 UTF-8（非 GBK）"。缺陷 2 反证 |
| 3 | 真实 GBK 文件里加 GBK 装不下的 `䶇`（U+4D87） | **闸门 1 拒写**；字节完全未变；无 `.encfs.tmp` 残留；模型没有硬试，而是读配置注释后**列了 4 个方案回头问用户**（改 writeEncoding 到 GB18030 / 目录 override / `\u4D87` 转义 / 放弃）—— 这正是 §3.3 要的行为 |
| 4 | grep 中文 `签名验证`（只在 GBK 文件里） | 我们的 grep 命中 `src/mix/…/WxInterfaceAction.java:432`，**输出里的中文是正确解码后的**（`数字签名验证失败`）。ground truth：`创建时间` 在 **610 个 GBK java** 文件里，内置 grep（UTF-8 单趟）**只看得到 2 个** → 缺陷 3 量化 |
| 5 | 系统提示注入（扩展同样 `-e` 加载，唯一差别是有没有配置） | 有配置：模型逐字引用了那段 `[encoding]` 提示；无配置临时目录：回答「**无**」。**A-8 正反证** |
| 6 | 读 832KB 真实 PNG（`WebContent/images/cwz/334001.png`） | 模型答"印章 + 红色"（视觉附件正常），**读操作后 PNG 字节完全未变**、`89 50 4E 47` 签名完好、无临时文件。T-9 图片保护 |

事件流证据留在 `C:/Users/yoyo3/AppData/Local/Temp/e2e-run1.json`、`e2e-run2.json`（`--mode json`）。

## 7. A-7 实测（`node tools/bench-p3.mjs`，真实工程带真实配置）

```
GBK java (161B)    裸读 0.08ms | 我们的 read 1.13ms | 新增 1.05ms
GBK java (8.4K)    裸读 0.07ms | 我们的 read 1.33ms | 新增 1.27ms
UTF-8 java (2.8K)  裸读 0.09ms | 我们的 read 0.87ms | 新增 0.78ms
```
判定阈值「读侧新增延迟 < 5ms」全部通过（约 4 倍余量）。grep：

```
UTF-8 趟（≈内置等价）177ms | GB18030 趟 182ms | Big5 趟 209ms（假阳性 0）
我们（非 ASCII 关键字 ≈ 2 趟）360ms → 约内置 2.0x
排除 .svn 后 1 个真命中 / 不排除 2 个（含 pristine 副本）
```
纯 ASCII pattern 只跑 UTF-8 一趟 → 与内置等速。

---

## 8. 与需求文档测试矩阵的对账

| 编号 | 覆盖位置 | 状态 |
| --- | --- | --- |
| T-8 无配置逐字节一致 | `test/operations.test.ts`（A-1 组）+ `edit-preview.test.ts` 新增无配置用例 | ✅ |
| T-9 图片/二进制不转码 | `test/classify.test.ts` + `test/operations.test.ts` + §6.3 #6 活体 PNG | ✅ |
| T-12 并发写 | `test/concurrency.test.ts` 3 用例（并驱动出两个真 bug） | ✅ |
| T-13 损坏文件不二次损坏 | P2 `test/gates.test.ts` + §6.3 #2（活体 U+FFFD 文件） | ✅ |
| T-14 配置热重载 | `configGeneration()` 进缓存键；`test/edit-preview.test.ts` "删配置后即使 mtime 不变也重评估"；`index.ts` `session_start`/`resources_discover(reload)` 清三缓存 | ✅（进程内改配置需 `/reload`，文档已写明） |
| T-15 `readStrategy:"config"` | `test/resolve.test.ts`（跳过字节判定，但 binary/unknown 仍拒写） | ✅ |
| A-8 零增长 | `test/sysnote.test.ts` + §6.3 #5 活体正反证 | ✅ |
| A-9 grep 命中 | `test/grep.test.ts` 27 用例 + §6.3 #4 活体（610 vs 2） | ✅ |

## 9. 已知遗留 / 交给 P4

- 无配置目录的 passthrough 写用普通 `writeFile`（保 A-1 的 inode/符号链接语义），**不是**原子替换；有配置且需要转码时才原子替换 —— 原子替换会换 inode，对硬链接/打开中的句柄有影响，README 要写一句注意事项。
- 系统提示的"是否有配置"判断在**会话首次** `before_agent_start` 时做一次并缓存（`noteOnce`）。会话中途新建配置需要 `/reload`（或重开会话）才注入提示 —— 但**读写路径不受影响**（每次都实时解析配置）。
- `escape` 输出 Java 风格小写 `\uXXXX`（非 BMP 拆代理对）。默认仍是 `error`，只在用户显式选择时生效。
- P4：README v2 重写（把 `CONFIG-GUIDE.md` 折进去）、CHANGELOG、`npm run fixtures` 校验、CI 首推、发布 `@yoyo3287258/pi-encoding-fs@0.5.0`。
