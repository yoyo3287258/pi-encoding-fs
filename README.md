# pi-encoding-fs

> ⚠️ **这是 fork（`yoyo3287258/pi-encoding-fs`），不是 npm 上的 `pi-encoding-fs@0.4.0`。**
>
> | | npm `0.4.0` | 本 fork 基线 |
> |---|---|---|
> | commit | `162bb04` | `69e4e47`（上游 `main` HEAD） |
> | 图片保护 | **缺失** —— 读 PNG/JPEG 会走 iconv 转码，**字节被破坏且模型收不到图片附件** | 有（`fix(read): preserve images when overriding Pi read ops` + `detectImageMimeType` hook） |
> | 读编码判定 | Python 3 + `chardet`（本机 pyenv 未初始化即永久退化为「配置说了算」） | **P1 起改为零依赖确定性字节判定** |
> | 非 GB 编码 | `resolve.ts` 里非 GB 一律短路成 UTF-8，`ISO-8859-1`/`Big5` 配置被忽略 | **P1 起任意 iconv 编码可用 + `force`** |
> | 不可映射字符 | 静默写 `0x3F`（生僻字丢失）；UTF-8 BOM 文件按 GB 写出头部变 `?` | **P2 起三道硬闸门：报错 / 回读自校验 / 拿不准就不写** |
> | 中文 `grep` | 单趟 UTF-8 搜索 —— 在真实 GBK 工程里基本搜不到（实测 `创建时间` 在 **610** 个 GBK java 文件里，单趟只看得到 **2** 个） | **P3 起多趟编码搜索 + 逐文件判定复核** |
> | 全局副作用 | 无条件覆盖 4 个工具 + 无条件往系统提示里塞话（污染非 GBK 项目） | **无配置树整体委托内置、系统提示零注入（A-1 / A-8）** |
>
> 因此**不要** `pi install npm:pi-encoding-fs`，请用本仓库（项目级安装，理由见下方 Requirements 与需求文档 §5.1/§5.2）。
> 本 fork 的包名是 `@yoyo3287258/pi-encoding-fs`（`0.5.0`）；尚未发布到 npm，现在只能用本地路径或 git 安装。
> 改造目标、红线与验收标准见需求文档
> [`REQ-pi-encoding-fs-fork.md`](https://github.com/yoyo3287258/pi-encoding-fs/blob/main/REQ-pi-encoding-fs-fork.md)
> （仓库根目录同路径），逐条验收证据见 [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)。

Encoding-aware `read` / `write` / `edit` / `grep` for [Pi](https://github.com/earendil-works).
Transparently handles GB18030 / GBK / GB2312 files while preserving Pi's native TUI
(diff view, syntax highlighting, line numbers).

## How it works

The extension registers tools with the same names as Pi's built-ins, overriding them.
`read`/`write`/`edit` reuse Pi's own tool skeletons via `createXxxToolDefinition`, injecting
encoding conversion only at the byte-IO layer, so Pi keeps computing and rendering diffs in
UTF-8. `grep` is self-implemented so it can search Chinese text inside GB-encoded files.

Encoding is decided **per file**, deterministically, with **no dependencies beyond
`iconv-lite`**: BOM → strict UTF-8 → UTF-16 → valid-but-illegal sequences (CESU-8 /
modified UTF-8) → legacy CJK candidate scan (GB18030/GBK/GB2312/Big5/EUC-KR, cross-validated
at byte level) → config. There is no confidence score and no guessing: if the bytes do not
decide it, the file is reported as `UNKNOWN` and the agent is told to stop and ask you.

The extension walks up from the file's directory to the nearest `.encoding-converter.json`.
If none applies to the tree, everything passes through byte-for-byte (identical to not having
the extension installed) and **nothing is injected into the system prompt**.

Three hard gates protect writes: (1) characters the target encoding cannot represent fail
loudly by default instead of silently becoming `?`; (2) after writing, the bytes are read back
and verified (full byte equality + re-classification + decoded-text equality), rolling back on
any mismatch; (3) when the encoding cannot be decided, the file is not written at all. Writes
to the same path are serialized so a concurrent writer can't be mistaken for a verification
failure. See [docs/CONFIG-GUIDE.md](./docs/CONFIG-GUIDE.md) and `docs/P*-NOTES.md`.

## Configuration

Place `.encoding-converter.json` in any directory. It applies to files at or below it,
unless a deeper config overrides it.

```jsonc
{
  "sourceEncoding": "GBK",        // 读侧兜底编码（字节判不出来时用）
  "writeEncoding": "GBK",         // 写目标；与 sourceEncoding 不同 = 显式迁移意图
  "unmappable": "error",          // error | escape | drop-to-gb18030
  "verifyWrite": true,            // 闸门 2（写后回读自校验）
  "protectUtf8": true,            // UTF-8 文件不被转码
  "readStrategy": "auto",         // auto | config
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
  "transcodeBash": false,         // P5 实验特性：false | "auto" | "<编码名>"（需重启 pi）
  "bashFileDump": true,           //   type/cat/Get-Content 倒文件时用该文件自身的读编码
  "overrides": [
    { "pattern": "docs/**", "encoding": "UTF-8" },
    { "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true, "unmappable": "escape" }
  ]
}
```

Full key reference, decision tables for the write target, recipes (legacy Java web, mixed
repos, all-UTF-8), Eclipse/Tomcat/SVN team notes and error-message reading:
**[docs/CONFIG-GUIDE.md](./docs/CONFIG-GUIDE.md)**. The file accepts `//` comments, and
validation problems are surfaced instead of silently ignored.

- `sourceEncoding`: fallback read encoding when bytes are undecidable; also the write target for new files.
- `overrides`: glob rules relative to the config file's directory; most specific wins.
- `confidenceThreshold` is still parsed for backward compatibility but **unused** (the old
  heuristic scorer is gone).

## Requirements

- A [Pi](https://github.com/earendil-works) agent (peer dependency; `>=0.84.0`).
- **No Python, no `chardet`, no other runtime dependency.** Reading and writing need only
  `iconv-lite` + `micromatch`.
- `grep` uses [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) — Pi ships one at
  `~/.pi/agent/bin/rg`, which this extension prefers; otherwise `rg` on `PATH` is used. If no
  `rg` is found, `grep` delegates to Pi's built-in grep.

## Install

Project-local (recommended for a legacy tree — the config, the tools and the trust decision
all stay with the checkout):

```bash
cd /path/to/legacy-project
pi install D:/path/to/pi-encoding-fs -l      # from a local clone
pi install git:github.com/yoyo3287258/pi-encoding-fs -l   # from git
```

User-wide (drop `-l`). Then run `/reload` inside Pi (or restart it) to pick up the tools,
and `/trust` if you want future sessions to skip the project-trust prompt. In non-interactive
runs (`pi -p`) pass `--approve` to trust project-local files for that run.

## Notes / limitations

- Only `read` / `write` / `edit` / `grep` are overridden by default. `bash`, `find`, and `ls` are not
  touched (e.g. a `cat` inside `bash` won't decode GB files) — see the next bullet for the opt-in.
- **P5 实验特性（默认关）**：`"transcodeBash": "auto"` 会把 `bash`/`powershell` 的字节输出也转成
  UTF-8（跟读文件用同一套字节判定；`type`/`cat`/`head` 倒文件时优先用那个文件自己的读编码）。
  合法 UTF-8 与二进制输出永远原样透传；关掉时连 `bash` 工具都不覆盖（零行为变化）。
  注意：这个开关**需要重启 pi** 才生效（工具注册在启动时定），`/reload` 不够。
  风险与实测见 [docs/P5-NOTES.md](./docs/P5-NOTES.md)；输出里混着两种编码时不要开。
- `grep` shells out to `ripgrep` **once per candidate encoding** (`--encoding` per pass; only
  for non-ASCII patterns; single-byte encodings are skipped because they cannot be
  distinguished from UTF-8 at byte level). Every raw hit is then re-checked by decoding the file
  through the same read chain `read` uses, so mojibake matches are dropped and ASCII matches
  inside GB files survive. Output format, notice wording and `limit` semantics match Pi's
  built-in grep; `--hidden` is added (like the built-in) but `.git` / `.svn` / `.hg` /
  `node_modules` are permanently excluded — in an SVN working copy `.svn/pristine` otherwise
  yields duplicate ghost matches (measured: 1 real hit vs 2 with the mirror). Where no config
  applies to the tree, `grep` delegates entirely to the built-in implementation.
- Writes that need transcoding go through an atomic replace (temp file + `fsync` + `rename`,
  with backoff retries for transient Windows locks). That **replaces the inode**, so hard links
  and open handles pointing at the old inode won't see the update; the file's own directory is
  always the temp location. Writes in trees with no config use Pi's plain write path so inode
  semantics there stay untouched.
- Concurrent writes to the same path are serialized per path. Verification compares the whole
  file, so an external process writing the same file mid-transaction is detected as a mismatch
  and rolled back rather than silently mixed.

### `edit` preview for GB-encoded files

Pi's `edit` tool reads the file in two places: `execute()` (via this extension's
encoding-aware `operations.readFile`, correct) and the TUI streaming _preview_
(`computeEditsDiff()`, which uses the built-in `readFile(path, "utf-8")` and bypasses
this extension). For a GB18030/GBK file the preview would read raw GB bytes as UTF-8
(mojibake), fail to match a Chinese `oldText`, and flash a false red
"Could not find the exact text in <path>" box during streaming — even though the real
edit succeeds.

This extension overrides `edit`'s `renderCall` so that non-UTF-8 files get an
encoding-aware preview instead: it reads through `operations.readFile`, computes the
diff with Pi's public `generateDiffString` + `renderDiff`, and renders a header that
matches Pi's native `edit` styling. UTF-8 files delegate to Pi's original renderer
unchanged.

Known trade-offs of this approach (no upstream change required):

- The preview uses **exact** `oldText` matching only (Pi's private fuzzy matcher isn't
  exported). If the model's `oldText` needs fuzzy normalization (trailing whitespace /
  smart-quote drift) the preview shows just the header, then the real edit runs and
  Pi's `renderResult` replaces it with the actual diff. GB files never get a false red
  error box anymore.
- The routing decision is made with the **same deterministic classifier** `read` uses
  (`classifyBuffer`) plus the nearest config, resolved through a synchronous config path that
  shares the config cache. That matters for single-byte legacy encodings (ISO-8859-1 /
  Windows-1252): they are undecidable at byte level, so only the config can say what they are —
  a plain "is it valid UTF-8?" probe would misroute them. The probe is cached by
  `(mtime, size, config-generation)`, so changing `.encoding-converter.json` re-evaluates even
  when the file didn't move.

## 三条路线（用户决策，不由实现者替你选）

面对一个“磁盘是 GBK、工具链全是 UTF-8”的项目，有三条路。本仓库只实现 **路线 A**，
但路线 B/C 是你的决策，不是代理应该擅自做的：

| | 做什么 | 适用 | 代价 / 风险 |
|---|---|---|---|
| **A（本扩展）** | 磁盘保持 GBK，编码差异吃在 IO 层 | 构建/部署链不受控（maven/gradle 都没有、Eclipse + Tomcat + SVN 的存量工程） | 零侵入、可回退。副作用：工具链以外的地方（`type`/`cat`）还是乱码，见 P5 |
| **B** | 整仓迁 UTF-8 | 能掌控构建与部署配置，且能接受一全性验证 | 需同步改：maven `project.build.sourceEncoding`、`maven-compiler-plugin<encoding>`、`maven-resources-plugin<encoding>`、JSP `pageEncoding`、Tomcat `server.xml URIEncoding`、log4j appender `encoding`、`native2ascii` properties、JDBC `characterEncoding`。收益最大、风险最白。**本扩展不做转码/迁移**（§7 Non-Goal） |
| **C（可叠加的中间态，已实测）** | `.gitattributes` 写 `*.java text working-tree-encoding=GBK`：工作树仍 GBK、git blob 存 UTF-8 → `git diff` / GitHub 浏览 / blame 中文全部正常（实测工作树 `b1ea cce2`，blob `e6a087 e9a298`） | 用 git 且只痛“看不了 diff”的项目 | ① **解决不了 pi 读文件**（agent 读的是工作树 → 路线 A 仍必需）；② `text` 触发 CRLF 归一（实测有 `LF will be replaced by CRLF` 警告），Windows 存量工程需显式 `eol=crlf`；③ 需 `git add --renormalize .` 且团队/CI 一致启用；④ 本机 Git-for-Windows 2.45 无 `checkout --iconv` |

> 本仓库自身的 `.gitattributes` 只声明“仓库内 LF + 二进制文件不走 EOL 转换”，
> **没**给下游工程写 `working-tree-encoding` —— 那是你仓库的决策，不是依赖应该带来的副作用。

## 先给仓库做一次编码画像

接手一个存量项目时，先看盘子，再写配置（零依赖，纯 Node）：

```bash
node tools/scan-encoding.mjs D:/path/to/project --out /tmp/profile.csv
```

输出每个文件的判定结果（`ascii/utf8/utf8-bom/cjk/utf16/binary/config/unknown`）、候选编码、
行尾风格，以及**已经坏了的文件**（含 `U+FFFD` / 锁定字串如锁斤拷）—— 这些是历史事故现场，
在改它们之前先确认基线。`--out` 的 CSV 可以直接排。

实测参考（真实 Java Web 工程 665MB / 25079 文件）：`.java` 4380 = 1266 ASCII + 3069 GBK + 45 UTF-8
（**同一个模块里混着两种编码**），`.jsp` 801 = 49 ASCII + 731 UTF-8 + 21 GBK，28 个文件已损，
103 个 UTF-8-BOM。这就是为什么“全局一个编码”的假设会毁数据。

可直接改用的配置样本：[`examples/legacy-java-web.jsonc`](./examples)、[`examples/mixed-repo.jsonc`](./examples)、
[`examples/all-utf8.jsonc`](./examples)。

## AGENTS.md 模板

如果你希望项目里的人/agent 都知道这套规则存在（而不只依赖系统提示），把下面这段贴到
项目根目录的 `AGENTS.md`（或 `CLAUDE.md`）。它和扩展注入的那段常量同构，但**额外告诉**
你团队的规则位置，且对不用 pi 的人同样有效：

```markdown
## 文件编码

- 本仓库用 `pi-encoding-fs` 扩展处理编码。`read`/`write`/`edit`/`grep` 已经按文件转码，
  **不要**再手动 `iconv`、不要“先转成 UTF-8 再改”、不要改文件编码。
- 规则在 `.encoding-converter.json`（允许 `//` 注释，注释里写了为什么）。
- 磁盘上是什么编码就保持什么编码；转码必须显式要求（`writeEncoding` ≠ 读编码，或 `force`）。
- 工具报错里看到「闸门 1 / 闸门 3」或 `[encoding: UNKNOWN]` → **停下来问人**，不要换策略重试。
- 不要在 `bash` 里用 `cat`/`type` 读非 UTF-8 源文件（会乱码）；用 `read` 工具。
```

## FAQ

**问：为什么不干脆把所有文件转成 UTF-8？**
答：那是迁移，不是工具职责（§7 Non-Goals）。转一次要同时改对 Eclipse 工程编码、`pageEncoding`、
Tomcat URI 编码、native2ascii、JDBC 参数、以及 SVN 上所有同事的工作副本 —— 错一环就是生产事故。
详见上面「三条路线」。

**问：我已经有 UTF-8 项目，装它会变慢吗？**
答：不会变错。没配置 → 完全透传且不注入系统提示（A-1/A-8）。有配置且文件都是 UTF-8 →
每个文件多一次字节判定（实测新增延迟 0.78～1.27ms，带缓存）。想完全避开就把配置文件删了。

**问：为什么 `grep` 不直接用一个编码？**
答：GBK 字节不是合法 UTF-8，单趟 UTF-8 搜索在真实 GBK 工程里只会看到零头：实测
`创建时间` 在 **610** 个 GBK java 文件里，单趟只看到 **2** 个。我们对非 ASCII pattern 跑多趟，
并用“该文件自己的读解码链”逐个复核，所以既不漏也不假阳性。

**问：报错说闸门 2 不通过，但我确信内容是对的？**
答：先查是否有其他进程（IDE 插件、格式化工具、索引起、云盘同步）在写同一个文件；闸门 2 比较的是
**整文件字节**，任何中途改动都会造成不一致并触发回滚（磁盘保持原样）。确认没竞争后，可以用
`verifyWrite: false` 关掉 —— 但我们**不建议**：这个闸门就是用来拓住“静默丢数据”的。

**问：`.properties` 里的中文怎么算？**
答：单字节/ASCII-only 的 properties 在字节层不可区分，只能靠配置。推荐
`{ "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true, "unmappable": "escape" }`
—— 写出的是 `\uXXXX`，与 Java `Properties.load()` / 老 `native2ascii` 约定兼容。

**问：扩展会把提示文字写进我的文件吗？**
答：不会。所有闸门/判定提示走 UI 通知和工具结果附注，`ops.readFile` 的字节缓冲区永不追加；
有用例钉住“escape 成功写之后磁盘字节里不含 `[encoding]`”。

**问：它支持 EBCDIC / ISO-2022-JP 吗？**
答：不支持（§7）：转义序列编码无法用“逐字节无损回环”安全判定。真需要就给那个目录配
`force` + 具体编码名，但请注意闸门 3 仍然会拒绝“不保无损”的写。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/CONFIG-GUIDE.md](./docs/CONFIG-GUIDE.md) | 安装、心理模型、**配置键全参考**、写目标决策表、真实场景配方、错误信息阅读、Eclipse/Tomcat/SVN 团队注意事项、GB18030 升级清单 |
| [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md) | §8 A-1…A-9 / §6.2 T-1…T-15 / §6.3 端到端逐条证据与可复现命令 |
| [docs/P0-BASELINE.md](./docs/P0-BASELINE.md) | fork 基线盘点与开工前的 Python 基线 |
| [docs/P1-NOTES.md](./docs/P1-NOTES.md) | 确定性字节判定的实现决定与实测证据 |
| [docs/P1-TEST-MAP.md](./docs/P1-TEST-MAP.md) | 上游 60 用例 → fork 现状的逐条对账（A-2 口径） |
| [docs/P2-NOTES.md](./docs/P2-NOTES.md) | 三道闸门与写链次序、真实工程影子树端到端证据 |
| [docs/P3-NOTES.md](./docs/P3-NOTES.md) | grep / 系统提示 / 预览路由 / 并发写，以及真实 `pi` 活体验收记录 |
| [docs/P5-NOTES.md](./docs/P5-NOTES.md) | `bash`/`powershell` 输出转码（实验特性、默认关）：注入点、判定顺序、两个活体跑出来的坑 |
| [CHANGELOG.md](./CHANGELOG.md) | fork 与上游的版本历史 |
| [docs/superpowers-upstream/](./docs/superpowers-upstream) | 上游原始设计/计划文档（保留存档，已改名以免混淆） |

## License

MIT
