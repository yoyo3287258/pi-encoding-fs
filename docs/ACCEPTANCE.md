# 验收对照（需求文档 §8 A-1…A-9 / §6.2 T-1…T-15 / §6.3 端到端）

每条都给**可复现命令**。以下命令均在仓库根目录执行；`$PROJ` = `D:/temp/OAWSSMS`
（665MB / 25079 文件 / 4380 java / 801 jsp 的真实 SVN + Eclipse + Tomcat 工程）。
环境：Windows 11、Node 24.19.0、pi 0.84.3。

```bash
npx tsc --noEmit                      # 无输出 = 干净
npx vitest run                        # 19 文件 / 242 用例
```

---

## §8 验收标准

### A-1 无配置目录逐字节一致 ✅

无配置时 `resolveReadPlan/resolveWritePlan` 返回 `null`（写侧 `plan.encoding === null`），
`ops.readFile` 直接返回原始字节，`ops.writeFile` 走 pi 原生 `writeFile(path, content, "utf-8")`
（**不做原子替换**，inode / 符号链接语义与未装扩展完全相同）；`grep` 整体委托内置实现。

```bash
npx vitest run test/operations.test.ts -t "passthrough"
```
```
✓ passthrough: no config returns raw bytes unchanged
✓ passthrough: no config writes UTF-8
✓ passthrough: edits a UTF-8 file (no config) staying UTF-8
```
另有 `test/grep.test.ts`「无配置 → 委托内置」、`test/sysnote.test.ts`「A-8 无配置目录 → 一个字都不注入」、
`test/edit-preview.test.ts`「无配置目录 → true（透传）」。

### A-2 上游测试不红 ✅（口径说明）

上游 `main@69e4e47` 共 **60** 用例。fork 现状 **203** 用例。逐条对账见
[`P1-TEST-MAP.md`](./P1-TEST-MAP.md)：54 个原样保留且绿；6 个迁移 —— 2 个 detector 用例随
Python 探测删除、3 个 `resolveFileEncoding` 用例改写到新判定链、1 个「配置说了算」断言按 §3.1
第 6 步（字节证据优先）翻向，并补了 `force` / `readStrategy:"config"` 两个用例表达原意图。

### A-3 T-1…T-15 全通过 + tsc 无错 ✅

见下方 §6.2 矩阵。`npx tsc --noEmit` 无输出。

### A-4 零 Python 引用 / 零新增运行时依赖 ✅

```bash
grep -rni "python\|chardet" src/ | wc -l
```
```
0
```
```bash
node -e 'const p=require("./package.json");console.log(p.dependencies)'
```
```
{ 'iconv-lite': '^0.6.3', micromatch: '^4.0.8' }
```
（`peerDependencies` 只有 pi 本体三包 + typebox；`devDependencies` 不进包。）

### A-5 GBK 项目改中文：`git diff` 不出现整文件重写 ✅

真实工程活体（§6.3 #1，模型通过本扩展编辑 `src/wsa/…/ISignService.java`）：

```bash
git diff --no-index --numstat -- $TEMP/e2e-original.java.bak \
  "D:/temp/OAWSSMS/src/wsa/java/com/bbg/uniform/wsa/service/ISignService.java"
```
```
1	1	C:/Users/.../e2e-original.java.bak => src/wsa/java/com/bbg/uniform/wsa/service/ISignService.java
```
即 **1 增 1 删**，不是 9 行全重写的整文件变更。补充校验：`161 → 161 字节`、
GBK 严格回环 ✅、`TextDecoder("utf-8",{fatal:true})` 仍抛错（= 真的还是 GBK，没被转码）、
无 `EF BB BF`、无裸 `0x3F`、CRLF 8 行 / 裸 LF 0、除目标行外逐字节一致。

> 注：这里用 `git diff --no-index` 是因为目标工程是 SVN 工作副本。§9 路线 C 记录了
> 「`*.java text working-tree-encoding=GBK`」这一中间态（工作树 GBK、blob UTF-8），
> 需要 git 仓库才适用；本 fork 不擅自改用户的 VCS 配置。

### A-6 UTF-8 保护 + 不可映射响亮失败 ✅

```bash
npx vitest run test/utf8-protect.test.ts test/gates.test.ts
```
```
✓ 编辑 ASCII 片段 =85.5 → =90.0：UTF-8 文件仍是合法 UTF-8，中文仍可读
✓ 同一目录里 GBK 文件与 UTF-8 文件同时被正确读出（上游只能对其中一半正确）
✓ protectUtf8:false 也不允许在没有 force 时静默转换（§3.2 只在 force 时放行）
✓ T-5 error（默认）：抛错、磁盘不动、消息含字符与 U+4D87
✓ T-5 drop-to-gb18030：自动升到 GB18030 并写成功，字节可被 GB18030 无损解回
✓ T-5 escape：写出 Java 转义 \\uXXXX（非 BMP 出代理对），文件仍是合法 GBK
✓ UTF-8-BOM 文件被按 GBK 写 → 拒绝（闸门 3）
✓ force 错配造成的 U+FFFD 内容 + GB 目标 → 拒绝（修缺陷 4）
```
活体反证（§6.3 #3）：在真实 GBK 文件里加 `䶇` → 闸门 1 拒写、**字节零变化**、无临时文件残留，
模型回头向用户列方案（改 `writeEncoding` / override / 转义 / 放弃）。

### A-7 首次 read 附加延迟 < 5ms，无每文件子进程 ✅

```bash
node tools/bench-p3.mjs
```
```
== A-7 真实工程（带 .encoding-converter.json）==
GBK java (161B)    裸读 0.08ms | 我们的 read 1.13ms | 新增 1.05ms
GBK java (8.4K)    裸读 0.07ms | 我们的 read 1.33ms | 新增 1.27ms
UTF-8 java (2.8K)  裸读 0.09ms | 我们的 read 0.87ms | 新增 0.78ms

== grep 趟数开销（真实工程 665MB / 25079 文件 / 4380 java）==
UTF-8 趟（≈内置 grep 等价）: 177ms | GB18030 趟: 182ms | Big5 趟: 209ms（假阳性 0）
我们（非 ASCII 关键字 ≈ 2 趟）360ms → 约内置 2.0x
命中数: UTF-8 趟 0 | GB18030 趟 1 | Big5 趟 0
不加 --glob 排除 .svn 时的命中数: 2 （含 pristine 副本 → 重复幽灵命中）
```
1MB 单文件判定阈值同样有用例（T-13）。**全链路零子进程**（读/写/判定都不 spawn；
只有 `grep` 按趟 spawn rg，而内置 grep 本来就 spawn rg）。

### A-8 无配置目录系统提示零增长 ✅（活体正反证）

同一个扩展、同一句提问，唯一差别是目录里有没有配置：

```bash
Q='你的系统提示里有没有提到 .encoding-converter.json？有就只贴出相关原文的第一句，没有就只回答「无」'
cd $TEMP/a8-NoUT4F && pi -p --approve --no-session -e D:/develop/pi/pi-encoding-fs/src/index.ts "$Q"
cd $PROJ                && pi -p --approve --no-session -e D:/develop/pi/pi-encoding-fs/src/index.ts "$Q"
```
```
无
Encoding (a `.encoding-converter.json` applies here): `read`/`write`/`edit`/`grep` convert
per file by deterministic byte classification — no guessing, no subprocess.
```
自动化用例：`npx vitest run test/sysnote.test.ts`（含「A-8 无配置目录 → 一个字都不注入」、
常量长度 < 760 字符、不含 python/chardet、含「stop and ask the user」）。

### A-9 CI（windows-latest + ubuntu-latest）✅ 已跑绿

工作流见 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)：两 OS 矩阵，
装 ripgrep（Windows 用 choco，Linux 用 apt）→ `npm ci` → `tsc --noEmit` → `vitest run` →
**A-4 门禁**（`grep -rni "python|chardet" src/` 必须为空）。

**已实测跑绿**（2026-08-29，分支 `feat/deterministic-classify`）：

| run | 结果 | 说明 |
|---|---|---|
| 33230915325 | ❌ failure | 首跑，两个 OS 各挂一条（见下） |
| 33231594192 | ✅ success | `ubuntu-latest / node 22` 与 `windows-latest / node 22` 双绿，含 A-4 门禁与 npm 包内容门禁 |

首跑红掉的两条都属于「只在开发者机器以外才暴露」，已各自修掉并加回归用例（详见 [P5-NOTES.md §4.3](./P5-NOTES.md)）：

1. **真 bug**：shell 输出转码把 OS 控制台码页当成了「判定优先级」——中文机 chcp=936 碰巧正确，
   英文码机（437）上 GBK 字节被解成框线乱码，比不转更糟。修成 `priorityEncoding`（项目声明，
   参与歧义优先级）与 `fallbackEncoding`（只在判定给不出结果时用）两层分开。
2. **阈值过紧**：A-7 的 `1MB < 60ms` 是本机隔离跑的严格值；19 个测试文件并行时本机可复现 72ms、
   runner 上 84ms → 改成数量级防退化（本机 <150ms / CI <400ms），严格值继续由
   `test/perf/a7-perf.test.ts` 与 `tools/bench-p3.mjs` 的隔离跑记录在 docs/P1-NOTES.md。

查状态（fork 上必须显式指定 repo，否则 gh 会去查上游 parent 而 404）：

```bash
gh api "repos/yoyo3287258/pi-encoding-fs/actions/runs?per_page=3" --jq '.workflow_runs[] | {id, status, conclusion}'
gh run view <run-id> --repo yoyo3287258/pi-encoding-fs --log-failed
```

---

## 已知偏差与上游事实修正（收尾阶段发现）

收尾时在“模拟另一台机器的全新项目”做了三个实验，出三条事实，与需求文档的假设不一致，
按实记录（呓着改验收口径没意义）：

| # | 发现 | 对验收的影响 | 处理 |
|---|---|---|---|
| 1 | **pi 0.84.3 内置 `read` 对非法 UTF-8 不报错**。`dist/core/tools/read.js:196` 就是 `buffer.toString("utf-8")`，Node 这个方法是**有损**的 | 需求 §3.4 / A-3 假设“内置会报错而不是给乱码”→ 不成立。实测无配置目录读 GBK 得到 `/** ???????? */`，而且模型会自己“补”成通顺中文并声称是原样引用 | A-1（无配置=与未装扩展一致）**继续成立且优先**，所以不改字节行为；改用两道非破坏性手段兑住：① `--init` 变成安装必做步骤（CONFIG-GUIDE ①②、INSTALL §4.1 写明不做等于没装）；② **方案乙已实现**（用户 2026-08-28 拍板）：字节与返回值一个不改（A-1 仍成立），但读/写非 UTF-8 文件时各寄存一条提示，写提示给出 svn revert / git checkout -- 的补救动作；新增 test/no-config-hint.test.ts 11 用例 |
| 2 | **`pi install <本地路径>` 不会装依赖**（只有 git 源会跑 `npm install`） | 文档里原先写的本地路径安装步骤照做会直接加载失败 | `docs/INSTALL.md` 写成实测路线 + 原文报错；README Install 一节同步 |
| 3 | **`--init` 参数当时根本不存在**（README/CONFIG-GUIDE 都写了它）；而早先在真实工程里那份配置是手写落盘的，所以没人发现 | 文档承诺了一个不存在的功能，新用户会“以为生成了配置” | 实现为一等公民（声明优先 / 最窄覆盖 / 矛盾声明不采纳 / `--dry-run` / 不默覆盖），并加 `test/scan-init.test.ts` 7 用例（子进程真跑）钉住 |

这三条全部来于“真装一次、真读一个文件”，不是推理得出的 —— 也是 A-9 要跑 CI 的理由里最硬的一条。

## §6.2 必测用例矩阵（T-1…T-15）

| ID | 断言 | 覆盖位置 | 状态 |
|---|---|---|---|
| T-1 | 全部 fixture 分类符合 §3.1；`unknown` 只在故意构造的非法样本上出现 | `test/classify.test.ts`（18 用例） | ✅ |
| T-2 | 每个 fixture `read→write` 逐字节相等 | `test/roundtrip.test.ts`、`test/utf8-protect.test.ts`、影子树 A-3 用例（164/164） | ✅ |
| T-3 | UTF-8 保护（GBK 配置目录里的 utf8.txt 编辑后仍 UTF-8） | `test/utf8-protect.test.ts` + 活体 §6.3 #2 | ✅ 头号回归点 |
| T-4 | ASCII 文件写中文 → 按 `writeEncoding` 落盘（不是 UTF-8） | `test/roundtrip.test.ts` | ✅ |
| T-5 | GBK 写 `䶇` → 闸门 1 抛错含 `U+4D87`；`drop-to-gb18030` 自动升级且字节合法 | `test/gates.test.ts`（3 策略） + 活体 §6.3 #3 | ✅ |
| T-6 | UTF-8-BOM 在 GB 配置下编辑：不产生 `0x3F`、BOM 保留 | `test/gates.test.ts`、`test/resolve.test.ts` BOM 组 | ✅ |
| T-7 | CRLF GBK 文件 edit 仍 CRLF 且不被双重转换 | `test/roundtrip.test.ts`（含幂等性） | ✅ |
| T-8 | 无配置透传 golden（含点文件仍可 grep） | `test/operations.test.ts`、`test/grep.test.ts`、`test/edit-preview.test.ts` | ✅ |
| T-9 | PNG/JPEG/`.class`/`.jar` 不转码；模型仍收 image 附件 | `test/operations.test.ts`（image content block）、`test/classify.test.ts`（UTF-32→binary）、活体 §6.3 #6 | ✅ |
| T-10 | grep：GBK 目录搜中文命中；行为与内置对齐（notice/limit/点文件） | `test/grep.test.ts`（27 用例） | ✅ |
| T-11 | `overrides` 特异性 + `force`（`*.properties`→ISO-8859-1 生效，上游不生效） | `test/config.test.ts`、`test/resolve.test.ts`、`test/edit-preview.test.ts` | ✅ |
| T-12 | 并发写同一文件无竞态损坏 | `test/concurrency.test.ts`（并驱动出 2 个真 bug，见 P3-NOTES §5） | ✅ |
| T-13 | 1MB 单次判定 < 60ms；缓存后 < 1ms | `test/classify.test.ts` | ✅ |
| T-14 | 配置热更新后缓存失效 | `test/resolve.test.ts` T-14 组（不手动清缓存也生效；mtime+size+`configGeneration`） | ✅ |
| T-15 | `readStrategy:"config"` 强制模式（可控，不崩溃） | `test/resolve.test.ts` T-15 组 | ✅ |

## P5（§5.5 可选阶段）—— 已实现，默认关闭

| 验证点 | 命令 / 位置 | 结果 |
|---|---|---|
| 默认关（A-1 延伸） | `shellRuleFor()` 无配置或 `transcodeBash:false` → `null`，`index.ts` 连 `bash` 都不覆盖 | ✅ `test/p5-shell.test.ts` “配置开关” |
| 真转码（活体 A/B） | 同一条 `head -c 200 <GBK 文件>`：关→**15 个 U+FFFD**乱码；开 `"auto"`→**0 个**、正确中文 + `[encoding] bash 输出已由 GBK 转成 UTF-8（161B→171B…）` | ✅ `%TEMP%\e2e-p5-off2.json` / `e2e-p5-on.json` |
| UTF-8 输出不改 | 单元用例 + 活体（`head -c 120` UTF-8 配置）→ 无附注、字节一致 | ✅ |
| 跳 chunk 半个汉字 | 3 字节一切喂入，结果无 U+FFFD | ✅ |
| 截断误判回归（只能真跑发现） | `head -c` 剪断 UTF-8 多字节字符 → 早期版本会整块转码（`─`→`鑄€`）；现在 `incompleteUtf8Tail()` 只放行“合法 UTF-8 序列前缀” | ✅ 含反向用例（ASCII + 末尾一个 GBK 汉字仍转码） |
| 行为回归防护 | 覆盖 `bash` 时镜像用户的 `shellPath` / `shellCommandPrefix` | ✅ `src/pi-settings.ts` + 用例 |
| 不做输入侧 | `echo 中文 > f.txt` 这类重定向不转（等于绕过三道闸门） | ✅ 设写不实现，文档明写 |

细节、判定优先级表与两个活体跑出来的坑见 [P5-NOTES.md](./P5-NOTES.md)。

## §6.3 端到端手工验收（真跑 pi 本体）

全部在 `$PROJ` 用真 `pi` + 真模型执行（扩展经 `pi install D:/develop/pi/pi-encoding-fs -l`
项目级安装；非交互跑加 `--approve`）。逐条命令与结果见
[`P3-NOTES.md`](./P3-NOTES.md) §6。摘要：

1. **GBK 项目里让模型改中文注释** → 1 行差异、仍是 GBK、未编辑部分逐字节完好（A-5）。
2. **混合编码目录**（根 GBK，`WebContent/MobileSSOA/**` 声明 UTF-8 但混着非 UTF-8 老文件）
   → 各自保持自身编码，未发生整目录转码。
3. **已损坏文件**（含历史 `U+FFFD` 的真实 UTF-8 java）→ 编辑后未新增损坏。
4. **不可映射字符** → 响亮失败 + 模型回头问用户（不静默变 `?`）。
5. **图片** → 832KB PNG 读后字节未变、视觉附件正常。
6. **grep 中文** → GBK 文件命中且输出中文正确解码（ground truth：`创建时间`
   在 **610** 个 GBK java 文件里，内置 grep 只看得到 **2** 个）。
7. **系统提示** → 有配置才注入（A-8 活体正反证）。

事件流原始记录：`%TEMP%/e2e-run1.json`、`%TEMP%/e2e-run2.json`（`pi --mode json`）。

---

## 需求文档 §9「备选路线」的处理

§9 要求把路线 A/B/C 写进 README 交用户决策，不由实现者擅自选 —— 已写入
[README「三条路线」一节](../README.md#%E4%B8%89%E6%9D%A1%E8%B7%AF%E7%BA%BF%E7%94%A8%E6%88%B7%E5%86%B3%E7%AD%96%E4%B8%8D%E7%94%B1%E5%AE%9E%E7%8E%B0%E8%80%85%E6%9B%BF%E4%BD%A0%E9%80%89)。
本 fork 的代码实现的是**路线 A**（磁盘保持原编码、转换吃在 IO 层）；
路线 B（整仓迁 UTF-8）明确不在功能范围内（§7 Non-Goals），只在
[CONFIG-GUIDE](./CONFIG-GUIDE.md) 里给「若要升级成 GB18030/UTF-8，需要同时改哪些构建与部署配置」
的检查清单；路线 C（`gitattributes working-tree-encoding`）作为可叠加的中间态记录，
本仓库自身的 `.gitattributes` 只做了「repo 用 LF + 声明二进制」，**没有**给下游工程写
`working-tree-encoding`，那是用户仓库的决策。
