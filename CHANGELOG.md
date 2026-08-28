# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。
`0.5.0` 起为 fork（`yoyo3287258/pi-encoding-fs`）的版本线；`0.1.0…0.4.0` 是上游
（`15wtyuan/pi-encoding-fs`）的历史版本，一并列出以便对照。

## 0.5.0 — fork（P1 判定器 / P2 三道闸门 / P3 生态 / P5 shell 输出转码）

**破坏性变更：读侧不再使用 Python + `chardet`；写侧从「配置说了算」改成「不损坏既有内容高于配置」。**

### 新增

- `src/encoding/classify.ts`：**零依赖确定性字节判定**。链条固定为
  BOM → 严格 UTF-8 → UTF-16（含 BOM）→ 合法-but-非法序列（CESU-8 / 修饰 UTF-8）→
  legacy CJK 候选字节互校（GB18030/GBK/GB2312/Big5/EUC-KR）→ 配置兜底。
  判不出来就是 `unknown`，不再有"置信度分数"这种东西。带 `(path,size,mtime,cfgFp)` 缓存。
- **三道硬闸门**（需求文档 §3.3，不可关闭）：
  1. **闸门 1 不可映射字符**：目标编码装不下 → 默认**报错**（列出字符与 `U+XXXX`），
     可选 `unmappable: "escape"`（Java 风格 `\uXXXX`，非 BMP 拆代理对）或
     `"drop-to-gb18030"`（仅 GB 家族内升级，逐字节兼容）。
  2. **闸门 2 写后回读自校验**：整文件字节等值 + 重新判定兼容性 + 解码文本等值，
     任一不符即回滚（新文件则删除半成品），报「磁盘保持原样」。
  3. **闸门 3 拿不准就不写**：`unknown`/`binary` 与「无法无损回环」的目标编码直接拒绝写，
     并指名命中的 override pattern 或配置目录。
- 写目标决策表（§3.2）：**已判定编码的文件默认保持自身编码**，转码必须显式要求
  （`writeEncoding` 与该作用域读编码不同才算表达迁移意图）。`docs/CONFIG-GUIDE.md` §2.2。
- `force: true`：字节层无法判定的编码（`ISO-8859-1`/`windows-1252`/`cp932`/单字节/`UTF-16BE`）
  只能靠配置声明，`force` 是显式接管开关（同时禁止"猜"）。
- 配置 schema v2：`writeEncoding` / `readStrategy` / `unmappable` / `verifyWrite` /
  `protectUtf8` / `autoCandidates` / `force`；`.encoding-converter.json` **允许 `//` 注释**；
  校验问题不再静默丢弃，会随 read 结果可见（`FoundConfig.warnings`）。
- `src/sysnote.ts`：**条件式系统提示**（A-8）。当前树里没有任何 `.encoding-converter.json`
  时一个字都不注入；有配置时注入的是常量文本（prompt cache 前缀仍稳定）。
- `src/notify.ts` + `tool_result` 钩子：闸门与判定的提示走 **UI 通知 + 工具结果附注**，
  永不进入 `ops.readFile` 的字节缓冲区（pi 的 `edit` 拿它当基线，进去就会被写回磁盘）。
- 二进制保护扩展：UTF-32 BOM 归 `binary`；图片附件路径保持原生（不转码、不破坏 PNG/JPEG 字节）。
- **P5（实验特性，默认关闭）**：`bash` / `powershell` 的**字节输出**转成 UTF-8。
  - 新键 `transcodeBash`：`false`（默认）/ `"auto"` / 具体编码名；`bashFileDump`（默认 true）：
    `type`/`cat`/`more`/`less`/`head`/`tail`/`Get-Content` 倒单文件时直接用**该文件自己的读编码**。
  - 注入点是 `createBashToolDefinition(cwd,{operations})` 的 `onData` —— 必须在
    pi 的 `OutputAccumulator`（非 fatal TextDecoder，不可逆）之前做完；
    `src/encoding/stream-transcode.ts` 用 iconv 的 stateful decoder 处理**跳 chunk 的半个汉字**。
  - 保证：合法 UTF-8 / 二进制 / 不可判定的输出**永远原样透传**；只有真转了才多一行
    `[encoding] bash 输出已由 GBK 转成 UTF-8…`（带“这个编码是谁定的”的依据 + lossy 提醒）。
  - `false` 时连 `bash` 工具都不覆盖（零行为变化）；开启后**需重启 pi** 生效。
  - 覆盖 bash 工具时从 `settings.json` 镜像用户的 `shellPath` / `shellCommandPrefix`
    （`src/pi-settings.ts`）—— 不这么做就是行为回归。
- 工具：`tools/scan-encoding.mjs`（`npm run scan` — 全仓编码画像 + 已损坏文件清单 + CSV）、
  `tools/bench-p3.mjs`（`npm run bench` — A-7 延迟与 grep 趟数实测）。
- 文档：`docs/CONFIG-GUIDE.md`（键参考、写目标决策表、配方、错误信息阅读、Eclipse/Tomcat/SVN
  团队注意事项）、`docs/P0-BASELINE.md`、`docs/P1-NOTES.md`、`docs/P1-TEST-MAP.md`、
  `docs/P2-NOTES.md`、`docs/P3-NOTES.md`、`docs/ACCEPTANCE.md`（§8 逐条证据）、
  `examples/{legacy-java-web,mixed-repo,all-utf8}.jsonc`、本 `CHANGELOG.md`。

### 变更

- **删除 Python + `chardet` 子进程探测**（`src/encoding/detector.ts` 与其测试）。
  原本机实测：`python` 是坏的 pyenv stub → 探测永久失败 → 编码判定静默退化成"配置说了算"。
- **`grep` 重写**：无配置树整体委托 pi 内置实现（零 UX 漂移）；每趟编码单独 spawn rg；
  每个原始命中用**该文件自己的读解码链**复核（修 GB 趟假阳性 + ASCII pattern 在 GBK 文件里的假阴性）；
  `--hidden` 且永久排除 `.git/.svn/.hg/node_modules`（SVN 的 `.svn/pristine` 会造成重复幽灵命中）；
  输出顺序确定化（排序后再按 `limit` 截断）；rg 优先用 pi 自带的 `~/.pi/agent/bin/rg`。
- **写串行化**（T-12 抓出来的真问题）：同一文件的「备份 → 落盘 → 回读校验 → 回滚」按路径串行，
  否则并发写会把好的写入误判成校验失败并回滚掉别人的更新（丢失更新）；
  原子替换的 `rename` 对 Windows 瞬时占用（`EPERM/EACCES/EBUSY`）做退避重试。
- `edit` 预览路由（§5.3）：从 `TextDecoder(fatal)` 二分法改为复用 `classifyBuffer` + 配置，
  单字节 legacy 编码终于能被正确路由；缓存键加入配置代数（改配置立即生效）。
- 无配置目录的写保持 pi 原生 `writeFile` 语义（不换 inode）；只有需要转码时才原子替换。
- 包元数据：改名 `@yoyo3287258/pi-encoding-fs`、`engines.node >=22.19.0`（对齐 pi 0.84.3）、
  peerDependencies `>=0.84.0`、`files` 带上文档与示例、新增 `verify`/`bench`/`prepublishOnly` 脚本。
- `confidenceThreshold` 仍可解析（兼容旧配置）但**不再使用**。

### 修复（对应上游 4 个缺陷）

1. **GBK 文件被整篇重写成 UTF-8** —— 写目标现在必须是"能无损回环磁盘字节"的编码，
   且判定为 `cjk` 的文件默认保持自身编码。
2. **UTF-8 文件被转成 GBK**（`protectUtf8` 之前只管"读"，不管"写"）—— UTF-8 保护覆盖写侧，
   UTF-8-BOM 文件按 GB 写出的路径直接拒绝（旧行为会把 BOM 写成 `?`）。
3. **中文 `grep` 在 GBK 工程里搜不到**（实测：`创建时间` 在 610 个 GBK java 文件里，
   内置 grep 只看得到 2 个）—— 多趟编码搜索 + 逐文件复核。
4. **不可映射字符静默变 `?` / BOM 头部损坏** —— 闸门 1 + 闸门 2。

### 工具与文档

- **修复 `tools/scan-encoding.mjs --init` 其实不存在**：README / CONFIG-GUIDE 一直写着“三步上手 ② 跑 --init”，
  但脚本里根本没有这个参数（会被当普通参数忽略）—— 用户会以为生成了配置其实没生成。
  现在把它实现为一等公民，并且推断优先级 = **工程声明 > 字节事实 > 最窄覆盖**：
  - 读 Eclipse `.settings/org.eclipse.core.resources.prefs`（`encoding/<路径>=X`，逐路径声明直接搬成 overrides）、
    `pom.xml` 的 `project.build.sourceEncoding`、gradle `encoding`、`.editorconfig` `charset`、
    `.gitattributes` `working-tree-encoding`（后者会被识别并提醒“那是路线 C，别跟本配置两层都转”）；
  - 没声明时，不再“取超集 GB18030”，而是取**能覆盖全部观测字节的最窄编码**（GB2312 不参与推断：
    它是 GBK 真子集、GBK 向后兼容，拿它当根编码只会白白多拒写）；
    选超集的危害是静默写出 Eclipse/GBK 读不懂的 4 字节序列；
  - **与字节矛盾的声明不采纳**，只报出来给人看（真实工程实测：`encoding/WebContent=GBK` 与范围内
    1965/2009 个文件的字节不符）；
  - `--dry-run`（只看建议，磁盘不动）、已有配置时默认**拒写并退出码 1**、`--force` 才覆盖；
    推断依据全部写进配置头部注释（配置要进版本库，同事得看懂为什么是这个值）；
  - 真实工程验证：推出 `sourceEncoding = GBK`（依据：“能覆盖全部 3114 个传统编码文件的最窄候选”），
    与手工部署的配置一致。修掉的三个实现坑：`iconv.getEncoding` **不是公开 API**（每次抛错→
    声明全被吞）、prefs 正则取值用了不存在的 `m[3]`、文件/目录判断的正则只允许 1 位扩展名。
- 新增 `docs/INSTALL.md`：另一台机器上的三条安装路线全部实测（含失败原文）。两个实测结论：
  **本地路径 `pi install` 不会帮你 `npm install`**（只有 git 源会），纯源码拷贝会直接报
  `Cannot find module 'micromatch'`；以及 git 源**必须钉 `@ref`**（本 fork 的 `main` 仍是上游 0.4.0 旧代码）。
- README 的 Install 一节重写为实测版本（含上面两个坑与“为什么必须跑 --init”）；
  CONFIG-GUIDE 从“三步上手”改为“四步上手”，第 ④ 步明确是**重启 pi**而不是 `/reload`。

### 测试

- 从上游 60 用例扩展到 **230 用例 / 18 文件**（`tsc --noEmit` 干净）。
- 新增：字节级判定矩阵、无损回环、UTF-8 保护、闸门 1/2/3（含 `verifyWrite:false` 反证、
  seam 抛错回滚、临时文件不残留）、写目标决策、真实工程影子树端到端（164 份真实文件：
  读→写幂等 164/164 字节一致）、并发写、系统提示 A-8、grep 27 用例、
  **P5 shell 输出转码 20 用例**（含一个只能靠真跑发现的回归：`head -c 120` 把 UTF-8 截成
  半个字符 → 早期版本会把整块 UTF-8 输出当成 GBK 转码）、
  **`--init` 工具行为 7 用例**（子进程真跑：声明优先、最窄覆盖、矛盾声明不采纳、
  不覆盖已有配置、`--dry-run` 不碰磁盘、生成的配置能被扩展自己解析且零警告）。
- 真实工程（SVN + Eclipse + Tomcat 的 665MB / 25079 文件 Java Web 项目）**活体 `pi` 验收**
  全部通过，命令与输出见 `docs/ACCEPTANCE.md`。

## 0.4.0 — 上游（npm 最新发布版）

- `feat(edit)`: 编码感知的 `edit` 预览（GB 文件的 diff 不再渲染乱码）。
- ⚠️ 该版本**没有**图片保护（下一个 commit 才修），`read` PNG/JPEG 会走转码破坏字节，
  且模型收不到图片附件。**不要**在 GBK 项目里用 `pi install npm:pi-encoding-fs`。

## 0.3.0 — 上游

- `feat`: 向系统提示注入编码说明（无条件注入 —— 本 fork 在 P3 改为条件式）。

## 0.2.0 — 上游

- `perf(grep)`: 用 `rg --encoding` 重写 grep，按配置分组；找不到 rg 时退回内置 grep。
- `test(operations)`: GB 编码 + CRLF 保持 + UTF-8 透传的 edit 测试。

## 0.1.0 — 上游

- 初始实现：就近配置查找、`resolve` 判定、Python + `chardet` 探测、
  编码感知的 `read`/`write`/`edit` 工具覆盖。
