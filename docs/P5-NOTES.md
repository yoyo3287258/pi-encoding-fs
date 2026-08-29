# P5 笔记：`bash` / `powershell` 输出转码（§5.5，实验特性，默认关闭）

需求文档把它列为**可选**并要求"默认关闭 + 文档写清是实验特性"。本阶段把它做成了
可开关、可回退、**关掉时零行为变化**的实现。

---

## 1. 注入点为什么只能是 `BashOperations.exec`

pi 的 shell 工具链是：

```
子进程 stdout/stderr ─(Buffer)→ onData ─→ OutputAccumulator.append
                                           └ new TextDecoder().decode(data, {stream:true})
```

`output-accumulator.js:25` 用的是**非 fatal** 的 TextDecoder —— 非法字节直接变 U+FFFD，**不可逆**。
所以：

- ❌ `tool_result` 钩子里改不了（那时已经是带 U+FFFD 的字符串了，P3 的回显通道不能复用在这）
- ❌ 没有 `bash_spawn` 之类的输出钩子（`extensions/types.d.ts` 里查不到）
- ✅ 唯一正确的层是 pi 公开导出的 `createBashToolDefinition(cwd, { operations })` /
  `createPowerShellToolDefinition`：我们包 `operations.exec` 的 `onData`，
  **在进 accumulator 之前**把字节转成合法 UTF-8

顺序上有个必须踩准的点：我们的 `flush()` 发生在 `base.exec()` 已 resolve、但
**pi 还没调 `finishOutput()`** 之前（pi 是 `await ops.exec(...)` 之后才收尾），
所以最后一段转码输出不会丢、也不会撞上 "Cannot append to a finished output accumulator"。
`test/p5-shell.test.ts` 里有一条「base 抛错（超时/中止）也要 flush」的用例钉住这个。

## 2. 顺手修掉的一个行为回归（不做就是坑用户）

pi 创建内置 bash 时传的是：

```js
bash: { commandPrefix: settingsManager.getShellCommandPrefix(), shellPath: settingsManager.getShellPath() }
```

而扩展 `registerTool` 是**整个替换**定义、扩展 API 又**不暴露** SettingsManager。
如果直接 `createBashToolDefinition(cwd, { operations })`，用户设过
`shellPath` / `shellCommandPrefix` 就会在装了本扩展后**静默失效**。
处理：`src/pi-settings.ts` 用 pi 自己导出的 `getAgentDir()` / `CONFIG_DIR_NAME`
定位 `settings.json`，镜像这两个键（项目级覆盖用户级，与 pi 合并顺序一致），
其余键一概不读。

另外一条硬约束：**只有 `transcodeBash` 真开着才注册 bash/powershell 覆盖**
（`shellRuleFor()` 同步判定）。默认关闭时连注册都不发生 → A-1（无配置/未开启 = 未装扩展）
不是靠"包一层但什么都不做"来保证的，而是根本不进这条链路。
代价：这个开关**需要重启 pi** 才生效（`/reload` 不够，工具注册在启动时决定）—— 已写进配置注释和文档。

## 3. 判定顺序（不引入任何"猜"）

`src/encoding/stream-transcode.ts`：攒够样本（默认 64KB）或进程结束时决策一次，之后不再改主意。

| 输出字节 | 行为 |
|---|---|
| 合法 UTF-8 / UTF-8-BOM / ASCII | **原样透传，一个字节都不改**（最常见，也是零风险保证） |
| 判定 `binary`（含 NUL 等） | 原样透传（绝不把二进制当文本解） |
| 判定 `cjk`（GB/Big5/EUC-KR 候选互校通过） | 按判定出的编码转 |
| 判定 `config`（字节说不出、但配置有声明） | 按配置的 `sourceEncoding` 转 |
| 判定 `unknown` 且**没有**显式编码 | 原样透传（不猜） |
| 判定 `unknown` 但**有**显式编码（`transcodeBash:"GBK"` 或 `type <file>` 命中该文件读编码） | 按显式编码解，能读出来的部分读出来，装不下的标 `lossy` 并在提示里说明 |

优先级：**该文件自身的读编码（倒文件场景）> 字节判定 > OS 码页 > 配置 sourceEncoding**。
"显式编码"只影响**怎么显示**，不碰磁盘，所以这里允许它压倒 `unknown`；
但**永远不压倒"这是合法 UTF-8"** —— UTF-8 保护在流式路径里同样成立。

`auto` 的 OS 码页探测：
- Windows `chcp.com` —— 注意**它自己的输出就是本地码页**（中文机上是 `»î¶´´úÂëÒ³: 936` 这种 GBK 字节），
  所以只正则取 ASCII 数字，别试图解码整行。936→GB18030（P-4：GBK 字节的超集）、950→Big5、932→CP932、
  949→CP949、1252→windows-1252、65001→不转。
- POSIX 走 `LC_ALL > LC_CTYPE > LANG` 的 charset 段；`UTF-8`/缺省 → 不转。
- 探测结果进程内缓存（一次），失败 → null（退到配置编码）。

跨 chunk 的半个汉字：交给 `iconv-lite` 的 stateful decoder（它内部保留残余字节），
测试里用「3 字节一切」强制制造拆分，断言结果无 U+FFFD。

## 4. 真实工程活体跑出来的两个问题

### 4.1 第一个版本会把「被截断的 UTF-8」误判成 GBK（已修 + 回归用例）

在 OAWSSMS 里跑 `head -c 120 .encoding-converter.json`（该文件是 UTF-8，注释里是框线字符 `─` = `E2 94 80`）：
120 字节正好剪在一个字符中间 → 严格 UTF-8 解码失败 → 候选互校说"这堆字节能当 GBK 无损回环" →
于是**把一份 UTF-8 输出转成了 `鈹€鈹€鈹€…`**，比不开还糟。

修法是这个场景特有的、但有原则的：区分"末尾是**合法的 UTF-8 序列前缀**"（`E2 94`）
和"末尾是杂散续字节"（`B4`）。只有前者可以忽略（`incompleteUtf8Tail()`），
且必须"去掉这段前缀后剩余部分是严格合法 UTF-8"。
反例也被用例钉住：`"status ok " + GBK("好")`（尾部 `BA C3`）**仍必须转码** ——
因为丢掉最后 1 字节是杂散续字节、丢掉 2 字节又只剩 ASCII，两道条件都不放行。

流式路径的截断来源比文件多得多（`head -c`、64KB 样本边界、子进程被 kill、管道被截），
这个坑不可能靠推理发现，只能靠真跑。

### 4.2 模型会把乱码"自动补全"成正确文本，并声称是原样引用

关闭转码时，pi 交给模型的是：

```
"… * @version ¶¯½¨Ê±¼ä£º2015Äê12ÔÂ25ÈÕ …"      ← 15 个 U+FFFD
```

而模型的回答是"**工具结果原样如下**"，后面跟着一段**完全正确的中文**
（它按上下文把 GBK 结构猜回来了），末尾才补一句"其实原始输出是乱码"。

这条值得单独记：它说明**"模型没抱怨"不等于"没坏"**，也说明 §3.3 的
"响亮失败 > 静默可用"是站得住的 —— 如果读侧也这样静默修好，人和模型都会以为链路是干净的。

## 5. 提示回显

转码发生时（只有真转了才提示）寄存一条，走 P3 的 `tool_result` 通道：

```
[encoding] bash 输出已由 GBK 转成 UTF-8（161B→171B；依据：按显式指定的 GBK 转码（字节不是合法 UTF-8））。
           这是实验特性，可用 transcodeBash:false 关闭。
```

`依据` 那一项是刻意带的：出问题时第一个要回答的就是"这个编码是谁定的"。
转码后仍出现 U+FFFD 时会追加一句"输出里混着该编码也装不下的字节"。

## 6. 实测 A/B（真 `pi`，OAWSSMS，同一条命令）

| 配置 | pi 交给模型的 bash 结果 | U+FFFD | 附注 |
|---|---|---|---|
| `transcodeBash` 缺省（关） | `@version ¶¯½¨Ê±¼ä£º2015Äê12ÔÂ…` | **15** | 无 |
| `"transcodeBash": "auto"` | `@version 创建时间：2015年12月25日 上午10:30:00` | **0** | `[encoding] bash 输出已由 GBK 转成 UTF-8（161B→171B…）` |
| `"auto"` + UTF-8 文件被 `head -c` 截断 | 原样字节（含正确 `─`） | — | **无**（未转码，4.1 修复后） |

原始事件流：`%TEMP%\e2e-p5-off2.json`、`e2e-p5-on.json`、`e2e-p5-fix.json`。
`cat -v` 那条还顺手给出字节级证据：GBK 的"创"= `B4 B4`（`M-4M-4`）✓。

## 6.5 性能实测（回答“开了会不会拖慢”）

命令：`node tools/bench-p5.mjs`（已进 package.json 的 `npm run bench:p5`）。本机 Windows / Node 24：

| 输出 | 纯转码器 | 真实命令端到端（基线 → 开启） |
|---|---|---|
| 1KB / 64KB GBK | 1.1ms / 1.6ms | 小命令的增量落在 spawn 噪声里（±20ms） |
| 5MB GBK（真转码） | 60ms（≈12ms/MB） | 126ms → 173ms（**+47ms**） |
| 5MB UTF-8 | 0.2ms | 108ms → 106ms（**噪声级 0**） |
| 5MB 二进制 | 0.1ms | 109ms → 125ms（噪声级） |

要点：
- 判定只看**前 64KB**，判成 UTF-8/二进制后逐块原样交还 → **最常见的情况增量真的是 0**；
- 只有\"真在转 GBK 大输出\"才有 ~12ms/MB，且加在命令本身的几十～几千毫秒之上；
- 真正需要知道的代价不是 CPU，是 **GBK→UTF-8 体积涨约 38%**（5.00MB→6.91MB）
  → 进上下文的字节变多；但 pi 的 bash 结果本来就截断到最后 2000 行 / 50KB，影响可忽略；
- 内存：决策前最多扣 64KB，不是整个输出。

## 7. 明确不做 / 限制

- **不做输入侧**（把模型写的 UTF-8 转成 GBK 再喂给命令）：`echo 中文 > f.txt` 这类
  重定向写文件属于"绕过闸门 1/2/3 的写"，本扩展一律不支持，README 里也提醒过。
- 输出里**混着两种编码**（UTF-8 进度条 + GBK 错误消息）时不要开：整体不是合法 UTF-8，
  会按一个编码解释，另一部分会变乱码。这是 opt-in 的代价，注释里写了。
- 不缓存决策跨命令：每条命令独立探测（编码偏好可能随命令变，比如同一次会话里
  既 `cat` GBK 文件又跑 UTF-8 的工具）。
- 大输出：决策前最多扣 64KB（只影响 UI 流式显示的首次刷新时机，不影响正确性）。
- 幂等性：转码输出必是合法 UTF-8 → 下一次同类命令仍走"UTF-8 透传"，不会二次转码。

## 8. 测试

`test/p5-shell.test.ts` 20 用例：透传/跨 chunk/二进制/preferred 优先序/扣住-再放/
lossy/empty/截断 UTF-8 回归/杂散续字节/`incompleteUtf8Tail` 边界/倒文件命令识别
（含 `cat *.java`、`cat a b` 放弃）/配置开关与垃圾值不悄悄开启/operations 包装三条
（转码、UTF-8 不改、异常也 flush）/OS 码页探测/settings 镜像两条。

全套：`npx tsc --noEmit` 干净，`npx vitest run` **19 文件 / 241 用例**全绿。
