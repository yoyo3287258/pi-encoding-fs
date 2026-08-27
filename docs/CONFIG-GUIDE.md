# 配置用法指南（`.encoding-converter.json`）

面向使用者。P4 会把这篇折进 README。

---

## 0. 三步上手

```bash
# ① 先看清项目里到底混了哪些编码（零依赖、只读、不改文件）
node tools/scan-encoding.mjs D:/temp/OAWSSMS > encoding-report.csv

# ② 在项目根写一份 .encoding-converter.json（本仓库 examples/ 有现成模板）
#    —— 参考下面 §3 的 GBK 老 Java Web 配方

# ③ 装扩展并验证
pi install -l @yoyo3287258/pi-encoding-fs     # 或开发期：npm link + pi 里 /plugin reload
npx vitest run                                 # 全绿即闸门生效
```

**没有配置 = 完全透传**，本扩展对目录不做任何事（§8 A-1 由测试锁死）。所以"先提交一份保守配置"
比"先不配、等出事再配"安全得多。

## 1. 三个心智模型（先记住这三条，配置就不会写错）

1. **读**：逐文件按**字节**判定，不猜、不 spawn 子进程。`sourceEncoding` 不参与"猜"，
   它只在三件事上起作用：① 歧义候选之间选哪个（GBK 与 Big5 的字节常常互相能无损回环）；
   ② 纯 ASCII 文件被写成什么；③ 新建文件被写成什么。
2. **写**：目标编码由配置决定，但**磁盘已有字节必须能在目标编码下逐字节无损回环**，否则不写
   （闸门 3）。这就是"永不损坏既有编码"的一般形式，UTF-8 保护只是它的一个特例。
3. **闸门优先于便利**：任何"说不清"的情况都是**响亮失败 + 告诉你下一步做什么**，
   而不是静默写坏。所以看到报错不要慌 —— 报错本身就是设计目标达成。

## 2. 键参考

| 键 | 默认 | 作用 | 什么时候改 |
|---|---|---|---|
| `sourceEncoding` | `GB18030` | 歧义优先级 + ASCII/新文件的写编码（无 `writeEncoding` 时也作写目标） | 项目主编码 |
| `writeEncoding` | = `sourceEncoding` | 写目标。**不会**把已有文件转码（那是 §7 之外的迁移），只决定新文件/ASCII 文件 | 想"读 GBK、写 GB18030"这种单向收紧时 |
| `unmappable` | `error` | 闸门 1 策略：`error` 拒写并列出字符与码点 / `escape` 转 `\uXXXX` / `drop-to-gb18030` 自动升级到 GB18030 并说明 | `.properties` 建议 `escape`（正好等于 native2ascii 约定） |
| `verifyWrite` | `true` | 闸门 2：写完回读 → 重新判定 → 字节与文本比对 → 不一致就回滚 | 只有为了刷盘性能才关 |
| `protectUtf8` | `true` | 含非 ASCII 的 UTF-8 文件不会被改写成 GB 系 | **别关**；真要转码请显式 `force` |
| `readStrategy` | `auto` | `config` = 跳过字节判定，强制按 `sourceEncoding` 解（极端场景：判定不了的自定义编码） | 少用；用它就得自己保证正确 |
| `autoCandidates` | `GB18030,GBK,GB2312,Big5,Shift_JIS,EUC-KR,EUC-JP` | 自动判定链（顺序即优先级）。**单字节/escape 编码禁止出现在这里**（性质 P-6：它们对任意字节都能"无损回环"，判定必然假阳性） | 想调歧义优先级时 |
| `confidenceThreshold` | — | 保留解析、**忽略使用**（不让上游旧配置报错） | 不用管 |
| `overrides[]` | `[]` | 按 glob 的局部覆盖，见 §2.1 | 见下 |

### 2.1 overrides 的匹配与优先级

- `pattern` 语义沿用上游：不含 `/` 的裸 glob 走 `matchBase`（`*.properties` 匹配任意层级的
  `.properties`）；含 `/` 的相对配置所在目录匹配。
- 多条同时命中时按**特异度打分**取一：字面段 10 > 含通配段 5 > `*` 2 > `**` 1。
  例：`conf/tplt/**`(31) 胜过 `*.properties`(5)。
- **override 里只写 `encoding` 时，它同时决定该作用域内"新文件/纯 ASCII 文件"的写编码**（P2 定稿）。
  例外：根配置带**迁移意图**（根 `writeEncoding` ≠ 根 `sourceEncoding`）时根赢，
  并且会产出一条 warning 教你怎么用 `"writeEncoding"` 显式锁回来。
- `force: true` 的三种正当用途：① 单字节编码（ISO-8859-1/windows-1252）；② 字节层原理上无法判定的自定义编码；
  ③ 你确实要把某个 UTF-8 文件转成 GB 系（破坏性，会警告）。

## 3. 配方

### 3.1 GBK 老 Java Web（Eclipse + Tomcat + SVN，无构建工具）

```jsonc
{
  "sourceEncoding": "GBK",
  "writeEncoding": "GBK",          // 与 Eclipse/Tomcat 的读取编码严格一致 ⇒ 工具链零改动
  "unmappable": "error",           // 生僻字直接报错，不会静默变 '?'
  "verifyWrite": true,
  "protectUtf8": true,             // 项目里那几十个真 UTF-8 的 .java/.jsp 永不被降级
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
  "overrides": [
    { "pattern": "WebContent/MobileSSOA/**", "encoding": "UTF-8" },
    { "pattern": "conf/tplt/**", "encoding": "UTF-8" },
    { "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true,
      "writeEncoding": "ISO-8859-1", "unmappable": "escape" }
  ]
}
```

为什么 `writeEncoding` 先用 GBK 而不是 GB18030：**GB18030 更好但要求工具链也按 GB18030 读**。
`writeEncoding: "GBK"` 保证"配置说的一切"与 Eclipse 现状完全一致，零风险；等团队把 Eclipse 工作空间
编码改成 GB18030 之后，把这一行改成 `"GB18030"` 即可 —— 性质 P-4（GB18030 是 GBK 严格超集，
对既有 GBK 字节逐字节不变）保证这次改动不会碰坏任何一个已有文件。

升级检查清单：

1. 全员 Eclipse：`Window ▸ Preferences ▸ General ▸ Workspace ▸ Text file encoding = GB18030`
   （以及 `.settings/org.eclipse.core.resources.prefs` 里那些 per-folder `encoding/...=GBK` 一并改）；
2. 改配置：`"writeEncoding": "GB18030"`；
3. 验证：`npx vitest run`（含影子树测试）+ 用 `tools/scan-encoding.mjs` 前后对比 CSV，
   `kind/chosen` 列不应变化（GB18030 文件本来就会被判成 GBK，字节不变）。

### 3.2 全 UTF-8 项目（多数现代仓库）

```jsonc
{ "sourceEncoding": "UTF-8", "writeEncoding": "UTF-8" }
```

装了也只多三层保护：UTF-16/BOM 文件保持原样、二进制拒绝写入、闸门 2 回读校验。

### 3.3 混合仓库（一个模块是 GBK，其余 UTF-8）

```jsonc
{
  "sourceEncoding": "UTF-8",
  "overrides": [{ "pattern": "legacy-gbk/**", "encoding": "GBK" }]
}
```

> ⚠️ 如果同一目录里 GBK 与 UTF-8 文件**混住**（OAWSSMS 就是：`.java` 里 GBK 3069 + UTF-8 45），
> 不要用目录 override 去表达 —— glob 表达不了文件级差异，而且一旦该目录里出现"另一种编码的例外"，
> 闸门 3 会拒写那个目录里的合法文件。字节判定本来就按文件粒度工作，这种情况**根本不需要 override**。

### 3.4 单个例外文件

```jsonc
{ "sourceEncoding": "UTF-8",
  "overrides": [{ "pattern": "docs/history/legacy-gbk-sample.md", "encoding": "GBK", "force": true }] }
```

`pattern` 支持任意 glob，写全路径即可精确到单文件。

## 4. 报错怎么读（三条真实消息）

**闸门 1**（GBK 装不下生僻字）
```
闸门 1 拒写 D:\...\Rare.java：目标编码 GBK 无法表示以下内容（写下去会永久变成 '?'）：
䶇(U+4D87)、𠀋(U+2000B)。建议把该目录/该 pattern 的 "writeEncoding" 改成 "GB18030"
（它是 GBK 的严格超集，对既有 GBK 内容逐字节不变，性质 P-4）。（当前 unmappable="error"；
也可用 "escape" 转 \uXXXX，或 "drop-to-gb18030" 自动升级）
```
→ 三条出路：改 `writeEncoding: "GB18030"`（+工具链同步）、该 pattern 设 `unmappable:"escape"`、
或设 `"drop-to-gb18030"`。**磁盘一个字节都没动。**

**闸门 2**（写完回读不一致 → 已自动回滚）
```
闸门 2（写后自校验）失败：写后回读的字节与预期不一致（8712B vs 8689B，可能被其它进程改写）。
已回滚为写前内容。
```
→ 通常是并发写/杀软或索引器占用。重试即可；反复出现就查是谁在同时写这个文件。

**闸门 3**（拿不准就不写）
```
拒写 D:\...\Foo.java：磁盘字节判定为 GBK，但目标写编码 UTF-8（来自 override "conf/tplt/**"）
不能无损表示它们（逐字节回环不相等，未改动的部分会被静默改写）。
建议：该 override 的 encoding 改成 GBK；若该文件确实是个例外，删了/改窄那条 override；
若真要降级转换，在该 pattern 上显式 "force": true。
```
→ 这条基本等于"你的 override 和现实冲突了"。按提示改窄 override。

## 5. 团队协作要点

- **把 `.encoding-converter.json` 提交进版本库**（SVN/git 一样），全组共享同一份决策；
  它不含敏感信息，就是纯编码声明。
- 配置所在目录就是作用域根（就近向上查找，与上游一致）。放在项目根 = 整棵树生效；
  放在某个子模块 = 只对该子树生效（子目录里的同名配置更就近胜出）。
- Eclipse/IDE 的编码设置必须与 `writeEncoding` 一致，否则 IDE 看到的是乱码而磁盘是对的 ——
  这类"看起来像扩展的锅"的问题，先跑 `node tools/scan-encoding.mjs <目录>` 对一下字节。
- 本 fork 支持 **JSONC 注释**（`//` 与 `/* */`），推荐配置就带注释提交。注意上游 0.4.0 不支持注释，
  带注释的配置**不要**回喂给上游版本。
- `.svn/` 目录、以及任何被判定为二进制的文件（`.class`/图片/字体）都不会被写入（闸门 3）。
  上游 0.4.0 之外的 npm 版本还会保护 PNG/JPEG magic；本 fork 走的是通用二进制判定。

## 6. 本扩展**不**做的事

- 不做编码迁移（GBK → UTF-8 批量转码）。§7 明确排除，`force` 也只影响单个被编辑文件的写出语义。
- 不修复历史上已被毁掉的文件（含 U+FFFD / 锟斤拷的那些）。它只保证**不再新增**损伤。
- 不碰 shell（bash/powershell）输出转码 —— 那是 P5 的独立 PR。
