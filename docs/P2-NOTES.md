# P2 实现说明（§3.3 三道硬闸门接入写链路）

分支 `feat/deterministic-classify`。基线：P1（`717b5d5`）。

## 1. 交付内容

| 位置 | 内容 |
|---|---|
| `src/operations.ts` | 写链路重写：闸门 1 → 行尾恢复 → 编码 → 补 BOM → 原子替换 → 写后回读自校验 → 失败回滚 |
| `src/operations.ts` | `WriteSeam` 注入点（`writeBytes`）：回滚路径可测；默认 `atomicReplace`（同目录临时文件 + fsync + rename） |
| `src/encoding/converter.ts` | `escapeUnmappable()`：不可映射码点 → Java `\uXXXX`（非 BMP 走代理对两次转义） |
| `src/config.ts` | `override.encoding` 与根 `writeEncoding` 的优先级定稿（见 §3.1） |
| `src/resolve.ts` | 闸门 3 的「无法无损回环」拒写信息点名命中的 override pattern |
| `test/gates.test.ts` | 12 条：T-5 三档策略、闸门 2 回滚三分支、闸门 3 端到端（含 T-6 缺陷 4 现场） |
| `test/e2e-oawssms.test.ts` | 9 条：真实工程**影子树**端到端（A-3/A-6/A-7/A-9），CI 自动跳过 |
| `test/perf/a7-perf.test.ts` | A-7 延迟（合成 300 文件） |

验证结果：`npx tsc --noEmit` 干净；`npx vitest run` → **14 files / 174 tests 全绿**。

## 2. 顺序为什么是「闸门 1 在编码之前」

`unmappable` 的三种策略都会改变"最终要落盘的文本/编码"（`escape` 改写文本、
`drop-to-gb18030` 换目标编码），因此必须发生在 `encodeFromUtf8()` 与行尾恢复之前；
而闸门 3 的 `plan.reject` 在决策层（`resolveWritePlan`）就已返回，最先执行。

实际执行序：**闸门 3（决策层）→ 闸门 1（文本/编码修正）→ 行尾恢复 → 编码 → 补 BOM → 闸门 2（落盘 + 回读）**。

## 3. 本轮新增/修正的设计决定

### 3.1 `override.encoding` 是否决定写目标（P2 新增语义）

**问题**（真实跑出来的，不是假想的）：推荐配置里 `{pattern:"conf/tplt/**", encoding:"UTF-8"}`
与根 `{sourceEncoding:"GBK", writeEncoding:"GBK"}` 并存时，`conf/tplt/velocity.properties`
（纯 ASCII）的写目标算哪个？P1 的实现是"根 writeEncoding 赢"→ 结果往一个声明为 UTF-8 的目录里
写出的新文件是 **GBK 字节**。这就是"脚阱"类缺陷。

**定稿规则**（`resolveFileRule()`）：

```
writeEncoding = override.writeEncoding                    // ① 最显式
             ?? (overrideRead && !migrationIntent)        // ② 「这个目录是 X」⇒ 该目录新文件写 X
                  ? overrideRead
             : root.writeEncoding ?? 合并后的 sourceEncoding  // ③ 根配置
```

`migrationIntent` := 根同时写了 `writeEncoding` **且** 与根 `sourceEncoding` 不同（例如 `GBK → UTF-8` 迁移）。
有迁移意图时根赢，避免目录级 override 悄悄推翻一次全局迁移决策；此时会产出一条 warning，
告诉用户在那条 override 里显式补 `"writeEncoding"` 就能反过来锁住。

两种语义都有测试钉住：`test/resolve.test.ts › override.encoding 与根 writeEncoding 的优先级（P2 定稿）`。

### 3.2 无配置目录的写仍然不走原子替换

透传路径（`plan.encoding === null`）继续用 `writeFile(abs, content, "utf-8")`，
与 pi 内置行为完全一致（§8 A-1），也保持"就地截断写"的 inode/符号链接语义。
只有本扩展真的转码时才 `atomicReplace`。

**已知副作用**（要进 README）：转码写会替换 inode → 硬链接/指向源文件的符号链接会断链；
SVN 只看内容哈希，不受影响。

### 3.3 回读自校验比"文档最小实现"更严

文档只要求「字节回读 → 判定 == 期望 → 解码 == 期望文本」。实现里额外做了两件事：

- **字节全等比较**（`Buffer.compare(written, expected)`）：能抓"另一个进程在同一瞬间也写了这个文件"；
- **BOM 长度由编码函数显式返回**，不用"嗅前 2/3 字节"的启发式 —— GBK 内容完全可能以
  `FF FE` 开头（那是合法的 GBK 字对），嗅探会把它误读成 UTF-16LE BOM 并导致假失败。

三条失败分支都有测试：字节不一致 / 判定不符 / 文本不一致；失败后分别
「回滚写前内容」或「删除写前不存在的半成品」。`verifyWrite:false` 时同一注入口**不再报错**，
反向证明拦人的确实是闸门（`test/gates.test.ts`）。

### 3.4 「已被前人毁掉」的文件不拒写（前提是不再叠加损伤）

真实工程里 28 个文件已含 U+FFFD / 锟斤拷。P1/P2 早期我以为 A-6 要断言"这些文件写必须被拒"，
影子树测试直接把我打脸：

- 被采到的 6 个受损文件，判定都是 **utf8**（U+FFFD 是以 UTF-8 形式躺在磁盘上的）；
- 目标编码 UTF-8 能无损表示 U+FFFD → 写回**逐字节相等** → 不该拒，拒了反而是误报。

所以 A-6 的可测性质被改写成一条更一般、也更强的不变量：

> **对任何采到的文件：写要么逐字节无损，要么被闸门响亮拒绝；绝不允许"写成功但字节变了且没报错"，
> 也绝不允许把非 `?` 写成 `?`。**

只有当目标编码装不下 U+FFFD（典型：`force` 成 GBK 后写回乱码文本）时闸门才拒 —— 这条由
`test/gates.test.ts`（`U+FFFD` 分支）与 `resolve.test.ts`（force 错配）钉住。

**本扩展不能修复历史损伤**，只能保证不再新增。要在真实工程里做"考古式修复"是另一件事
（需要人读上下文猜原字），超出 §7 范围。

## 4. 实测证据（可复现）

```
$ npx vitest run
 Test Files  14 passed (14)
      Tests  174 passed (174)

$ npx vitest run test/e2e-oawssms.test.ts
采样：扫了 7157 个文本文件 → 影子树 158 个（other-text:10 properties:10 gbk-java:40
     ascii-java:40 damaged:6 utf8-java:20 utf8-jsp:20 gbk-java:40 gbk-jsp:12）
读→写幂等：158 个真实文件，不一致 0 个                      ← A-3
受损文件 6 个：无损写回 6，闸门拒写 0，违规 0                 ← A-6
UTF-8 保护：43 个（其中 0 个 BOM 需还原）                     ← 缺陷 1 的反面
GBK java：40 个，目标非 GBK 的 0 个                           ← Big5/EUC-KR 误判 0
100 个真实 java（平均 12.3KB）：首次 read 附加 1.36ms（基准 6.81ms）
  ｜缓存后 read 0.00ms｜三道闸门全开 write 10.87ms            ← A-7（<5ms）
采样内 GBK java 行尾：CRLF 40 / LF 0 / 混用 0                 ← 与 §11 画像一致
```

合成树（`test/perf/a7-perf.test.ts`）：
```
300 次「读+改+写」8.7KB GBK 文件：平均 3.69ms/对
1MB GBK 文件：首次 read 22ms｜缓存后 read 20ms｜带闸门 write 82ms
```

注：`test/e2e-oawssms.test.ts` 只在能找到工程时运行（`OAWSSMS_DIR` 可覆盖路径），
CI 上整文件跳过 —— 它是**本机证据**，不是 CI 保证。所有写操作只发生在临时影子树里，
真实 SVN 工作副本零改动。

## 5. 遗留（下一步）

- 闸门 1 的 `escape`/`drop-to-gb18030` 说明目前只在异常文本里（成功写没有回显通道）；
  读侧 warning 也还没呈现给模型 —— **P3** 用 `ctx.ui.notify()`（pi 0.84.3 提供 `select/confirm/input/notify`）
  + §5.2 的条件性系统提示落地。
- T-12（并发写同一文件）、T-8/T-9（无配置目录逐字节透传对照）、T-1/T-15 的 grep 侧 → **P3**。
- `docs/CONFIG-GUIDE.md`（用法指南，已随本阶段产出）在 P4 折进 README。
