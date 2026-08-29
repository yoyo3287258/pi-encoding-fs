# P1 实施记录：判定器（§3.1 / §3.2 决策层）

对应需求文档 §10「P1 判定器」，验收面 T-1…T-7、A-4。
本文件记录**所有偏离文档字面之处**及其理由，便于逐条追认。

## 落地范围

| 交付 | 文件 |
|---|---|
| 确定性判定器 + 缓存 | `src/encoding/classify.ts`（新增） |
| 删除 Python/chardet 探测 | `src/encoding/detector.ts`（**已删**）、`test/detector.test.ts`（已删） |
| 编码原语重写 | `src/encoding/converter.ts`（删 `resolveFileEncoding`，加 `normalizeEncoding`/`unmappableChars`/`canEncodeAll`/单字节与转义序列识别） |
| 决策层重写 | `src/resolve.ts`（`resolveReadPlan` / `resolveWritePlan`＝§3.2 矩阵 + 闸门 3 的拒绝点；保留 v1 包装 `resolveReadEncoding`/`resolveWriteEncoding`） |
| schema v2 | `src/config.ts`（`ResolvedConfig`、`force`、`writeEncoding`、`readStrategy`、`unmappable`、`verifyWrite`、`protectUtf8`、`autoCandidates`；overrides 同时接受 v1 的 `sourceEncoding` 与 v2 的 `encoding`） |
| IO 注入 | `src/operations.ts`（读：图片保护 → 计划 → 解码；写：计划 → 行尾保真 → BOM 还原 → 拒绝即抛） |
| fixture | `test/fixtures/build.ts` + `test/fixtures/gen.ts`（`npm run fixtures`），测试用 `test/helpers/tree.ts` |
| 取证工具 | `tools/scan-encoding.mjs`（`npm run scan <dir>`）、`tools/test-map.cjs` |

新增测试：`test/classify.test.ts`、`test/roundtrip.test.ts`、`test/utf8-protect.test.ts`、
`test/write-matrix`（并入 `test/resolve.test.ts`）；`npx vitest run` = **140 passed**，`npx tsc --noEmit` 干净，
`grep -rni "python\|chardet" src/` = **0 命中**（A-4；连注释里的字样也清掉了）。

## 与 §3.1 判定链的 4 处有意差异（都有测试锁定）

1. **UTF-32 BOM 归入 `binary`**。`FF FE 00 00` 同时是 UTF-16LE BOM 的前缀；Node 的 TextDecoder 不支持
   UTF-32，按 UTF-16 解必然产出 U+FFFD。判成 binary = 读不转码 + 写被拒，是安全侧。
2. **新增 `kind: "config"`**，表示「按配置解码、跳过了字节判定」，携带 `configReason: "force" | "undecidable"`：
   - `force: true` → 显式覆盖（§4）。
   - 配置里写的是**字节层根本无法判定**的编码（单字节 ISO-8859-*/windows-125x，或 §7 排除的转义序列编码）
     → 隐式按配置解。理由：性质 P-6 说这类编码不能进自动候选，但若用户已经明确说「这棵树是 ISO-8859-1」，
     再逼他每处都写 `force` 只会制造 unknown（读透传、写被拒），可用性差。
   - 两种情况都不覆盖 BOM/binary 守卫（那两个证据更强）。
3. **大文件短路扫描**：`> 512KB` 时不做穷尽候选扫描（实测 1MB 全 7 候选回环 = 141ms，违反 T-13 的 60ms 预算）。
   `chosen` 与 §3.1 完全一致（配置优先命中即停），只有 `candidates`/`ambiguous` 不保证穷尽，
   用 `exhaustive: false` 显式暴露。**真实工程没有影响**：OAWSSMS 的 .java 平均 8.7KB、最大 ~100KB。
4. **候选顺序 + 配置优先的实际效果**：OAWSSMS 里 3114 个 GBK 文件**全部**同时能通过 Big5（712 个还能过 EUC-KR）
   的逐字节回环 —— 即 `ambiguous` 在 CJK 树里是常态而不是异常。因此：
   - 有配置时（正常情形）直接取 `sourceEncoding`，不再无谓扫描；
   - 无配置时才会因 `ambiguous` 输出候选链提示。

## 新增的一道闸门（文档没写，但按 §3.3 的立场推出来）

**写目标必须能在磁盘字节上无损回环**（`src/resolve.ts` 分支⑧）。
这是 §3.2「UTF-8 文件不被转成 GB」的**一般形式**：任何「目标编码装不下既有字节」的写入，
都会把**用户没编辑的那部分**静默改掉。因此：

- `writeEncoding=GB18030` 而磁盘是 GBK → 放行（P-4：超集，逐字节不变）；
- `writeEncoding=GBK` 而磁盘含 GB18030 4 字节扩展字符 → **拒绝**（否则变成 `?`）；
- `writeEncoding=UTF-8` 而磁盘是 GBK → **拒绝**（GBK 字节不是合法 UTF-8，回环不等）——
  这正是 §7「不做编码转换/迁移」的落地点：想做迁移必须显式 `force`；
- `force: true` 时放行，但按 §3.2 行④ 的要求补一次「不 force 时的字节判定」，用于产出
  「磁盘上是 UTF-8 文件，正在按 GBK 重写 —— 破坏性语义变更」警告（否则 force 会让警告本身也失去依据）。

配套：**force 解码已产生 U+FFFD 且这坨乱码真要写回** → 拒绝（消息里点明「配置与文件真实编码不符」）。

## 关于「读结果里追加警告行」（§3.1 最后一句）的实施约束

pi 的 `edit` 会把 `ops.readFile()` 的文本当**基线内容**写回，所以任何被追加进 buffer 的提示，
下一次 edit 就会变成文件内容 —— 这正是我们要消灭的那类污染。因此 **note 只在
「该文件的写入本来就会被闸门 3 拒绝」时追加**（`unknown`、force+U+FFFD 两种），
此时不可能发生污染（写了会被拒）。其余配置类 warning 不进 buffer，改由 P3 的
系统提示注入（§5.2）与 UI 通知承担 —— 见 `ReadPlan.warnings` / `WritePlan.warnings`。

## 其它决定

- **UTF-16 目标一定写 BOM**：无 BOM 的 UTF-16 文本每个 ASCII 字符都带一个 NUL 高位字节，
  下一次字节判定必然落 `binary`，等于自断后路。
- **BOM 由我们在字节层还原**（`WritePlan.addBom`），因为 pi 的 `splitBom` 会剥掉
  `edit` 读到的 U+FEFF；上游正是漏了这一步才有缺陷 4（`iconv.encode('\uFEFF…','gbk')` 首字节 0x3F）。
- **坏 JSON 配置不再静默失效**：上游 `loadConfigInDir` 把异常吞成 `null` → 用户以为配置生效了、
  实际整棵树在透传。现在解析失败会保留「这里有配置」的事实并给出 warning。
- **§4 的示例可以带注释**（jsonc）：`stripJsonComments` 容忍 `//`、`/* */`，字符串字面量不受影响。
- `confidenceThreshold` 按 §4 要求继续解析但**不参与任何决策**（`ResolvedConfig` 里没有这个字段）。
- 包名/版本/peer 按 §10 改为 `@yoyo3287258/pi-encoding-fs@0.5.0` + `@earendil-works/pi-* >=0.84.0`
  （装到的是 0.84.3，与本机 pi 同版本）。

## 需求文档的两处笔误（实测）

1. §6.2 T-5 里的 `䶇 U+4DB7` → 实际 **U+4D87**（`𠀋 = U+2000B` 是对的）。
2. §12 的「iso-8859-1 / windows-1251 对 0x00-0xFF 全字节回环相等」→ 只对**槽位全定义**的编码成立；
   windows-1251/1252 有 `0x81/0x8D/0x8F/0x90/0x9D` 五个未定义槽位，撞上就不相等。
   结论不变（单字节编码禁入自动候选），测试按实况写。

## 目标项目（D:/temp/OAWSSMS）画像与推荐配置

> ⚠️ **本节里的配置已被 P2.1 定稿取代**（当时 `writeEncoding` 写的是 GB18030，且写目标语义还没收紧）。
> 现行版本：`D:\temp\OAWSSMS\.encoding-converter.json`（已落地）与 `docs/CONFIG-GUIDE.md` §3.1 /
> `examples/legacy-java-web.jsonc`。画像数据本身仍然有效。下面保留原样是为了记录推理过程。

扫描：`node tools/scan-encoding.mjs D:/temp/OAWSSMS`（7393 个文本文件，5.6s，二进制扩展名跳过）

| 事实 | 数值 |
|---|---|
| `.java` | 4380 = 纯 ASCII 1266 + **GBK 3069** + **合法 UTF-8 45**（分散在 9 个 `src/*/java` 模块里，**同目录混住**） |
| `.jsp` | 801 = ASCII 49 + **UTF-8 731** + **GBK 21**；pageEncoding 声明 UTF-8 732 / GBK 26 / ISO-8859-1 1 |
| 声明 vs 字节 | 759 个有 pageEncoding 声明的 jsp 里，**0 条冲突**；差异只在纯 ASCII 文件（字节层本就无法区分） |
| `.properties` | 10 个，全 ASCII（所以 §11 Q3 的 ISO-8859-1 风险目前为 0） |
| 行尾 | GBK java：CRLF 3004 / LF 61 / 混用 4 → 行尾必须逐文件保真 |
| 只有 GB18030 能无损回环的文件 | **0 个** → 该项目当前不含扩展区 B/C 字符，构建编码留 GBK 也够用 |
| unknown | 0 个 |
| UTF-8 BOM 文件 | 103 个（`WebContent/MobileSSOA/**` 的 html/css/js） |
| 构建 | 无 maven/gradle：Eclipse JDT（`targetPlatform=1.7`）+ WTP/Tomcat + SVN；`.settings/org.eclipse.core.resources.prefs` 里**已有 10 条逐文件编码设置**（前任工程师在同同一问题搏斗） |

**结论：这个项目的混合是「文件级」而不是「目录级」的 —— `overrides` 的 glob 表达不了它**
（同一目录里既有 GBK 又有 UTF-8 的 .java）。所以 §3.1 的逐文件字节判定 + §3.2 的 UTF-8 保护
是唯一可行路线；只靠配置（上游缺陷 1 退化后的行为）必然毁掉那 45 个 java + 731 个 jsp。

给该项目的配置（放在项目根 `.encoding-converter.json`，SVN 里作为版本化文件共享给全组）：

```jsonc
{
  // 读：逐文件字节判定（下面两个字段只在「歧义/新文件/纯 ASCII」时起作用）
  "sourceEncoding": "GBK",        // 与 Eclipse `encoding/WebContent=GBK` 一致
  "writeEncoding": "GB18030",     // P-4：对既有 GBK 字节逐字节不变；将来出现生僻字也不会变 '?'
  "unmappable": "error",          // 闸门 1；若 Eclipse 编码只能停在 GBK，把 writeEncoding 也改回 GBK
  "verifyWrite": true,            // 闸门 2
  "protectUtf8": true,            // 保护那 45 个 UTF-8 java 与 731 个 UTF-8 jsp
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
  "overrides": [
    { "pattern": "WebContent/MobileSSOA/**", "encoding": "UTF-8" },  // 103 个带 BOM 的静态资源
    { "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true } // 目前全 ASCII，先立规矩
  ]
}
```

> 若 Eclipse 那边不能改成 GB18030 读取（`encoding/WebContent=GBK` 保留），把
> `writeEncoding` 改回 `"GBK"` 即可：闸门 1 会拒绝任何写进 GBK 的生僻字，
> 而不是静默写成 `?`。两种取向都被本 fork 的一实现覆盖，不需要改代码。
> 客户项目源码**不进本仓库**，只有上述统计与合成 fixture（`test/fixtures/build.ts`）。

## 下一步（P2）

闸门 1（`unmappableChars` 已在 converter 里就位）+ 闸门 2（`atomicReplace` 已在 operations 里就位，
待接写后回读自校验与回滚）+ T-5/T-6/A-6。
