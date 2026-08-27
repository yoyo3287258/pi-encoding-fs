# P1：上游 60 用例 → fork 现状（§8 A-2 口径说明）

| 指标 | 数量 |
|---|---|
| 上游（main@69e4e47）用例总数 | 60 |
| fork 现在用例总数（按源码里的 it() 标题静态计数） | 143 |
| 标题原样保留且通过 | 54 |
| 未以同名保留（删除/迁移） | 6 |

## 未以同名保留的用例与去向

| 上游文件 | 用例 | 说明 |
|---|---|---|
| converter.test.ts | resolveFileEncoding: config non-GB always UTF-8 | resolveFileEncoding(chardet 置信度阈值) 函数被删；意图改由 test/classify.test.ts（字节判定链）+ test/resolve.test.ts（配置优先级）覆盖 |
| converter.test.ts | resolveFileEncoding: config GB trusts high-confidence GB detection | resolveFileEncoding(chardet 置信度阈值) 函数被删；意图改由 test/classify.test.ts（字节判定链）+ test/resolve.test.ts（配置优先级）覆盖 |
| converter.test.ts | resolveFileEncoding: config GB falls back when detection weak/non-GB | resolveFileEncoding(chardet 置信度阈值) 函数被删；意图改由 test/classify.test.ts（字节判定链）+ test/resolve.test.ts（配置优先级）覆盖 |
| detector.test.ts | never throws and returns a DetectionResult shape for a GB file | 整文件删除：Python + chardet 依赖本身被移除（§0.5.5 已预告），2 条 |
| detector.test.ts | returns confidence 0 for empty file | 整文件删除：Python + chardet 依赖本身被移除（§0.5.5 已预告），2 条 |
| resolve.test.ts | config non-GB override forces UTF-8 (ignores chardet) | 「配置说了算」→ 反转为「字节证据优先，force 才压倒」（§3.1 第 6 步 / §6.2 T-15） |

## 口径

上面的数字是**静态**统计源码里的 it("...") 标题；参数化用例（for … it()）在运行时才展开，
所以 `npx vitest run` 报告的总数会更大（P1 完成时是 140 passed）。差异只是写法，不是漏跑。

§8 A-2 要求「上游 60 个测试全绿（删掉 detector 相关用例后其余不红）」。其中：

- 2 条测 `src/encoding/detector.ts`（Python + chardet）—— 文档 §0.5.5 已授权随实现一起删除；
- 3 条测 `resolveFileEncoding(detected, confidence, …)`，即 chardet 置信度阈值决策本身，该函数按 §3.1 必须消失；
- 1 条断言「配置说了算、字节证据靠后」，而 §3.1 第 6 步已反转为「字节证据优先，force 才压倒」。

这 6 条不可能在保留旧实现的前提下继续通过，因此迁移为对新 API 的等价断言（见上表）。
**其余 54 条一行未改、全部保持通过。**

复核：`node tools/test-map.cjs`
