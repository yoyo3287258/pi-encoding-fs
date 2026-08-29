# 需求文档：pi-encoding-fs fork —— 去 Python 的确定性编码判定改造

- 文档版本：v1.2（2026-08-27）｜v1.2 变更：预检发现**开工会堵住的必修项**→新增 §0.5.0（git 协议 ssh→https），并预填账号 `yoyo3287258`
  v1.1 变更：新增 §0.5 环境准备与 fork/clone 自动化移交（含凭据边界与失败退路）
- 交付对象：**下一个 pi 会话（在 fork 仓库的工作目录里执行）**
- 上游项目：`15wtyuan/pi-encoding-fs`（MIT）→ fork 到 `yoyo3287258/pi-encoding-fs`
- 目标运行环境：pi `0.84.3`（本机 `@earendil-works/pi-coding-agent`）、Node 24.19.0、Windows 11（同时要求 Linux CI 通过）
- 一句话任务：**把"读靠 chardet 猜、写靠配置强制"的上游，改造成"读靠零依赖的确定性字节判定、写靠配置但绝不损坏既有编码"的编码感知文件工具，并消除 4 个已知缺陷。**

---

## 0. 给下一个会话的执行卡（TL;DR）

1. **先确认 §0.5.1 的登录已由用户完成**（`gh auth status` 必须 ✓ Logged in），**并执行 §0.5.0 的 git 协议修正（预检实测为必修，否则第一条 clone 就堵）**。然后执行 §0.5.2 的 agent 自动 fork+clone。
   目标基线：`https://github.com/yoyo3287258/pi-encoding-fs` 的 **`main`（69e4e47）**，**不是 npm 0.4.0**（npm 版缺图片保护，会损坏 PNG/JPEG）。
2. 先读 §11 的问题（含 0 号环境前置），**向用户确认后再动手**。
3. 按 P0→P4 顺序实施（§10）。**P1/P2 是核心价值，P5（bash 转码）可选**。
4. 不可协商的红线见 §3.3「三道硬闸门」；任一不满足即视为未完成。
5. 完成后必须给出 §8 的 9 条验收证据（可复现命令 + 输出）。

---

## 0.5 环境准备与 fork/clone 移交边界（人做什么 / agent 做什么）

> 本节的目的：让用户侧的手工操作压缩到**一次登录**，其余（fork、clone、建分支、测试、PR、看 CI、修红）全部由 agent 用 `gh` 非交互完成，形成闭环。

### 0.5.0 ⚠️ 预检发现的**唯一必修项：git 协议从 ssh 改 https**

2026-08-27 在本机对账号 `yoyo3287258` 做过实际预检，结果如下（好消息为主，但埋了一个坑）：
```
gh version 2.98.0 (2026-08-20)                ✓
gh auth status → ✓ Logged in to github.com account yoyo3287258 (keyring)   ✓
Token scopes: 'admin:public_key','gist','read:org','repo'  → 含 repo，fork / push 权限无障碍 ✓
Git operations protocol: ssh                  ← 坑在这
ssh -T git@github.com → "Connection closed by 20.205.243.166 port 22"   ← 出站 22 端口不通或密钥未被接受
~/.ssh/ 下有 id_rsa / id_rsa.pub，但未验证已登记到 GitHub
git 全局 credential 配置里只有内网 192.168.10.183 的 generic，**没有 github.com 的 gh 助手**（= 未跑过 gh auth setup-git）
```

**后果**：`gh repo fork yoyo3287258/... --clone` 呚出 `git@github.com:yoyo3287258/pi-encoding-fs.git`，在 agent 的**非交互 bash**（stdin 被 harness 关闭）里会**失败或挂住**：host key 确认、passphrase 提示、密码输入全都不可交互。

**修法（两条命令，完全非交互，agent 自己跑即可，无需用户动手）：**
```bash
gh config set git_protocol https --host github.com
gh auth setup-git
# 验证（不落盘、不改动远端）：
git config --global --get-regexp "credential\.https:\/\/github" || echo "FAIL: 未注册 gh 凭据助手"
git ls-remote https://github.com/15wtyuan/pi-encoding-fs HEAD      # 期望输出一个 sha；无任何提示 = HTTPS 免密可用
```
两条都成功，才继续 §0.5.2。若用户坚持用 SSH：GitHub 支持 `ssh.github.com:443`（在 `~/.ssh/config` 加 Host 块），但**私钥带 passphrase 时在 agent 里仍然输不了口令** → 要么先交给 ssh-agent 要么就回退 HTTPS。**本文档默认选 HTTPS。**

### 0.5.1 人做一次（约 2 分钟，**必须在普通终端里，不能在 pi 会话里**）

```powershell
winget install --id GitHub.cli -e --source winget   # 装完必须重开终端，PATH 才生效
gh --version                                        # 预期 2.x
gh auth login                                       # 选 GitHub.com → HTTPS → Login with a browser
gh auth status                                      # 必须看到 ✓ Logged in to github.com account <你的用户名>
```

**为什么这步不能交给 agent（硬约束，不要试图绕过）：**
pi 的 bash 工具把命令写进子进程 stdin 后**立刻 `end()`**（`dist/core/tools/bash.js:53-63`：`child.stdin?.end(command)`），子进程没有可用的交互输入通道。因此 `gh auth login` 的交互提示（"Press Enter to open github.com" + 8 位设备码 + 浏览器确认）**在 agent 的 bash 里必然挂住或失败**。凭据存在 gh 自己的配置里、跨会话持久，所以人做一次，后续所有 pi 会话都免登录。

**可选替代（agent 可全程代办，但有两个坑）：**
```powershell
# Windows 环境变量设完必须重开终端 + 重启 pi，否则 agent 继承不到
[Environment]::SetEnvironmentVariable("GH_TOKEN","<token>","User")
```
- 坑 1：**用 classic PAT（scope 勾 `repo`）**。fine-grained PAT 对「创建仓库 / fork」这类账号级操作存在 GitHub 官方承认的 feature gap，实测常返回 `403 Resource not accessible by integration`。（此结论我在写本文档时未能查到权威定论，属于"按经验选更稳的那个"，若你的 fine-grained token 能成功 fork，就用它，范围更小更好。）
- 坑 2：`gh auth login --with-token` 需要 stdin；在 agent 里必须写成 `printf '%s' "$GH_TOKEN" | gh auth login --with-token`（内部管道，可用），单独 `gh auth login --with-token` 会因 stdin 被 harness 关闭而报错/挂起。

**网络前置**：`gh` 要直连 `api.github.com`，`npm i` 要能访问 registry。若本机走代理：`export HTTPS_PROXY=http://127.0.0.1:<port>`；npm 不稳时改用镜像 `npm config set registry https://registry.npmmirror.com`，或在 pi 的 `settings.json` 里配 `npmCommand`。

### 0.5.2 agent 自动完成（按顺序执行，每步都带验证，失败即停下报告）

```bash
# 1) 认证与身份确认（GH_USER 应解析为 yoyo3287258，与本文档已预填的用户名一致）
gh auth status 2>&1 | tee /tmp/gh-auth.log
GH_USER=$(gh api user --jq .login); echo "GH_USER=$GH_USER"
[ -n "$GH_USER" ] || { echo "未登录或 token 无效 → 回到 §0.5.1，不要继续"; exit 1; }

# 2) 确认上游可 fork（本仓库为 public、未归档；0 star / 单作者不构成 fork 障碍）
gh api repos/15wtyuan/pi-encoding-fs --jq '{full_name, fork, archived, default_branch, pushed_at}'

# 3) fork + clone 一步（gh 官方语义：传 OWNER/REPO 时自动在本人账号下建 fork 并可 clone；
#    新 fork 成为 origin；-- 之后可追加任意 git clone 参数）
mkdir -p ~/work && cd ~/work
gh repo fork 15wtyuan/pi-encoding-fs --clone -- --depth 50
cd pi-encoding-fs

# 4) 校验 fork 归属与 remote（origin=你的 fork，upstream=原作者）
gh repo view --json nameWithOwner,isFork,parent --jq '{nameWithOwner,isFork,parentOwner:.parent.owner.login}'
git remote -v

# 5) 校验基线必须是 main HEAD 69e4e47（含图片保护修复；npm 0.4.0 = 162bb04，缺这个修复）
git log --oneline -3
#   浅克隆下不用 merge-base（可对象不足而报错），用 log 直接断言：
git log --oneline | grep -q "^69e4e47 " && echo "OK：基线含图片保护修复" \
  || { echo "FAIL：基线不对，切到 upstream/main 后重试"; git fetch upstream main && git checkout -B main upstream/main; }
git rev-parse --short HEAD   # 应为 69e4e47（或其后继）

# 6) 将本文档归入仓库（账号已在 v1.2 预填为 yoyo3287258，此处仅做一致性校验 + 兜底替换）
cp "$HANDOFF_DOC" ./REQ-pi-encoding-fs-fork.md   # $HANDOFF_DOC = 用户交接的本文档路径（当前在 D:/develop/pi/test/）
[ "$GH_USER" = "yoyo3287258" ] || sed -i "s/yoyo3287258/$GH_USER/g" REQ-pi-encoding-fs-fork.md
git add REQ-pi-encoding-fs-fork.md && git commit -m "docs: 加入确定性编码判定改造需求文档"

# 7) P0 基线：绿了才允许进入 P1
cd ~/work/pi-encoding-fs && npm i
npx vitest run          # 期望：Test Files 8 passed / Tests 60 passed
npx tsc --noEmit        # 期望：无错误
grep -rn "python\|chardet" src/ | tee /tmp/python-baseline.txt | wc -l   # 记录 P1 前命中数（非空），P1 后必须为 0

# 8) 建工作分支（不要直接在 main 上写）
git checkout -b feat/deterministic-classify
```

上面第 6 步已将本文档纳入版本管理（方便以后每个会话/队友都看得到）；若你选了先开发后补文档，至少保证**交付前一次性 commit 进去**。

### 0.5.3 agent 后续用 gh 完成的闭环（对应 §8 A-9）

```bash
git push -u origin feat/deterministic-classify      # 首次推送前先向用户确认目标仓库+分支（见 §0.5.4）
gh pr create --title "feat: 去 Python 的确定性编码判定 + 三道写入门禁" --body-file /tmp/pr.md
gh pr checks                                  # 看 CI 红绿
gh run list --limit 5 ; gh run watch <run-id> ; gh run view <run-id> --log-failed
gh repo sync --source upstream                # 需要同步上游时使用（先确认不冲突）
gh release create v0.5.0 --generate-notes     # 交付
gh issue create --repo 15wtyuan/pi-encoding-fs --title "..." --body "..."   # 可选：向上游回报/回贡 patch
```

**fork 上 Actions 可能默认不跑**（GitHub 对新 fork 的 workflow 需一次性批准）。先试：
```bash
gh api -X PUT "repos/$GH_USER/pi-encoding-fs/actions/workflows/ci.yml/enable"
gh workflow list
```
若仍提示 workflows aren't running on this fork，**告知用户去 Actions 页面点一次「I understand my workflows, go ahead and enable them」**——这是第二个、也是最后一个必须人做的动作。

### 0.5.4 凭据与写入边界（agent 必须遵守）

| 禁止 | 原因 |
|---|---|
| 读取、打印、拷贝 `gh auth token` 的值；把 token 写进仓库文件 / `.npmrc` / CI 日志 | 凭据外泄最廉价的途径；且需求文档本身可能被分享 |
| 未经用户确认就 `git push --force`、改 `main`、删远端分支、`gh release` | fork 虽是用户的，但破坏性写入必须确认 |
| 未经确认就向 `15wtyuan/pi-encoding-fs` 提 PR/Issue | 会打扰上游维护者 |
| `gh api -X DELETE` 任何仓库/文件 | 不可逆 |

需要用户确认的最小集合（一次问完，别反复打断）：① push 的目标仓库与分支名；② 是否开 PR（以及是否同步提给上游）；③ 是否发 release / 是否 `npm publish`（注意包名需改成 `@yoyo3287258/...` 或加后缀，避免与 npm 上已有的 `pi-encoding-fs` 冲突）。

### 0.5.5 失败退路表

| 症状 | 判定 | 处置 |
|---|---|---|
| `gh: command not found` | PATH 未刷新 | 重开终端；或 `winget upgrade --id GitHub.cli`；仍无则 `where gh` 手工确认安装目录并加入 PATH |
| clone/push 报 `Connection closed by ... port 22` 或 `Permission denied (publickey)` | gh 的 git_protocol 仍是 ssh，且出站 22 不通 / 密钥未登记 | **执行 §0.5.0 两条命令切 HTTPS**；不要试图在 agent 里输 passphrase |
| `gh auth status` 显示未登录 | §0.5.1 没做 | **停下**，让用户在普通终端做，不要试图交互登录 |
| fork 返回 `403 Resource not accessible by integration` | token 是 fine-grained，账号级操作被拒 | 换 classic PAT(`repo`)，或改用设备流登录 |
| `fork already exists` | 用户之前 fork 过 | 复用：`git clone https://github.com/$GH_USER/pi-encoding-fs`，然后 `git fetch upstream main && git merge --ff-only upstream/main`，并检查 `69e4e47` 是否在内 |
| `npm i` 卡在 `@earendil-works/pi-*` peer | 网络/镜像 | 换 npmmirror；或 `npm i --prefer-offline`；必要时 `pi -e` 的临时目录里已有安装可参考 |
| CI 里 `python` 相关测试报错 | 删了 `detector.ts` 但测试没同步 | 属预期：删除 `test/detector.test.ts`（2 用例）并记录在 CHANGELOG；**其余 58 个必须全绿**（§8 A-2） |
| 首次 `gh run list` 空 | fork 的 workflow 未批准 | 见 §0.5.3 末，让用户点一次启用按钮 |

---

## 1. 背景：为什么必须做这件事

pi 的内置文件工具在字节层是 **UTF-8 硬编码**，且对非 UTF-8 文件的行为是**静默成功 + 不可逆损坏**：

| 位置（pi 0.84.3 dist） | 代码 |
|---|---|
| `core/tools/write.js:21` | `fsWriteFile(path, content, "utf-8")` |
| `core/tools/edit.js:43` | `fsWriteFile(path, content, "utf-8")` |
| `core/tools/edit.js:221` | `buffer.toString("utf-8")` |
| `core/tools/read.js:196` | `buffer.toString("utf-8")` |
| `core/tools/grep.js:140` | rg 参数里**没有** `--encoding`，但**有** `--hidden` |
| `core/bash-executor.js:40`、`output-accumulator.js:25` | `new TextDecoder()`（默认 UTF-8） |
| schema：`{path, content}` / `{path, edits}` | 无 `encoding` 字段，模型没有传编码的入口 |

pi 的 `edit` 只感知 **BOM**（`utils/text.js:splitBom`）和 **行尾 CRLF/LF**（`edit-diff.js:detectLineEnding/restoreLineEndings`），**没有编码探测、没有二进制守卫**。

### 真实事故（本机可复现，见 §12）
一个 46 字节的合法 GBK 文件，只因为 agent 改了一个纯 ASCII 片段 `=85.5`→`=90.0`：
```
工具返回：Successfully replaced 1 block(s)      ← 报告成功
结果字节：efbfbd efbfbd e2a3 ba ...              ← U+FFFD 泛滥，46B → 94B
再用 GBK 解回：锟斤拷锟解：锟斤拷锟斤拷锟侥硷拷      ← 原中文永久丢失
```
目标用户场景：**接手一个 .java/.jsp 全部为 GBK 编码的老 Java Web 项目**，需要长期用 pi 辅助编程。

---

## 2. 上游现状盘点（fork 的起点）

上游规模很小（src 约 900 行 + 354 行 edit-preview），**测试全绿可作为改造安全网**：
```
npx vitest run → Test Files 8 passed (8) / Tests 60 passed (60)   （已在 Windows/Node24 实测）
npx tsc --noEmit → 通过
```

| 文件 | 行数 | 处置 | 说明 |
|---|---|---|---|
| `src/index.ts` | 63 | **改** | 注册 4 个同名覆盖工具 + 注入 `ENCODING_NOTE` 系统提示（§6.1 全局副作用） |
| `src/operations.ts` | 83 | **重写核心** | 字节 IO 注入点；`readAsUtf8Buffer` / `writeEncoded` |
| `src/resolve.ts` | 50 | **重写** | 编码决策。当前缺陷：`if (!isGBEncoding(sourceEncoding)) return "UTF-8"` |
| `src/config.ts` | 81 | **扩展** | 就近向上找 `.encoding-converter.json` + glob overrides（设计良好，保留） |
| `src/grep.ts` | 269 | **改** | 自实现 rg grep；无条件替换全局 grep（§6.2） |
| `src/edit-preview.ts` | 354 | **保留** | 修 pi `edit` 预览绕过 `operations` 的真 bug，很有价值 |
| `src/encoding/detector.ts` | 74 | **整体删除** | Python + chardet 探测（§3 首要目标） |
| `src/encoding/converter.ts` | ~80 | **重写** | `isGBEncoding` / `resolveFileEncoding` 用新判定器替代 |
| `src/encoding/line-endings.ts` | — | 保留 | CRLF 保真 |
| `src/encoding/mime.ts` | — | 保留 | 图片二进制保护（仅存在于 main，**npm 0.4.0 没有**） |
| `test/*.test.ts` | 60 tests | 保留 + 大幅扩充 | 改造期间的回归安全网 |

上游依赖：`iconv-lite@^0.6.3`、`micromatch@^4`；peer：`@earendil-works/pi-*`、`typebox`。
**注意：pi 直接运行 TS（`package.json` 的 `pi.extensions` 指向 `src/index.ts`），无构建步骤**，fork 后改代码即生效。

### 上游的 5 个缺陷（本项目要消除 1/2/3/4）
1. **读编码依赖 Python + chardet**。用户机器上 `python --version` 是 pyenv 未初始化报错 → `detector.ts` 永远返回 `{encoding:null, confidence:0}` → 静默退化为"配置说了算" → **GBK 树里混入的真 UTF-8 文件会被按 GBK 解码再按 GBK 写回 → 该文件被毁**（事故镜像）。
2. **只支持 GB 系**：`resolve.ts` 里非 GB 一律当 UTF-8 透传，所以配置写 `ISO-8859-1`/`Big5`/`windows-1252` **会被忽略**（Java `.properties` 规范默认 ISO-8859-1，老项目常见）。
3. **不可映射字符静默变 `?`**：`iconv.encode('䶇','gbk')` → 写入 `0x3F`。人名字/地名生僻字（CJK 扩展 B/C）无声丢失。
4. **UTF-8 BOM 文件被 GB 编码写出时头部变 `?`**：pi `edit` 把 `bom + content` 原样传给 `ops.writeFile`（`edit.js:238` 附近），而 `iconv.encode('\uFEFF'+'标题：测试\n','gbk')` 首字节 = `0x3F`（**已实测**）。
5. **不覆盖 `bash`/`powershell`**：`mvn compile`/`javac` 的中文报错照旧乱码（上游 README 自己写明）。→ 列为 P3 可选。

---

## 3. 设计核心（本项目的灵魂）

### 3.1 读：确定性判定，零外部依赖

> 决策前提（用户已确认）：**读文件用确定性判定，写文件用编码配置规范。** 这个不对称是有意的——
> 读错的后果是"屏幕上看到乱码"（可见、可恢复）；写错的后果是"磁盘数据永久损坏"（不可逆）。
> 所以：**读要判得准、拿不准就明确报错；写要拿不准就不写。**

已实测的性质（fork 必须依赖并可复用这些事实）：

| # | 性质 | 实测证据 |
|---|---|---|
| P-1 | 真实中文 GBK 源码**绝不会**被判为合法 UTF-8 | 231 字节 GBK Java 样本：`TextDecoder('utf-8',{fatal:true})` 抛错 → `validUtf8=false` |
| P-2 | 合法 UTF-8 文件被误判成 GBK 时，逐字节回环**不相等** | `utf8.txt`(64B) → `gbkExact=false` |
| P-3 | GBK 字节的 GBK/GB18030 回环**逐字节相等**，且解码无 `U+FFFD` | `gbk.txt`(46B) → 两者 `ok=true` |
| P-4 | **GBK 内容用 GB18030 编出逐字节不变**（GB18030 是 GBK 严格超集，2 字节区完全一致） | 同一份 GBK 字节经 GB18030 回环 `true` |
| P-5 | iconv 解码非法字节会产生 `U+FFFD`，可作为额外闸门 | `[80 90 A0 FF FE 81]` → `"€悹\uFFFD\uFFFD䜩"` 含 `U+FFFD` |
| P-6 | **单字节编码对任意字节总能回环**，绝不允许进自动判定 | `iso-8859-1`、`windows-1251` → `true`（必须 `force` 才可用） |
| P-7 | 截断的多字节序列会被 fatal 解码捕获 | `Buffer.from('中文中','utf-8').subarray(0,7)` → 非法 UTF-8 |

**判定算法（必须严格按顺序实现，命名为 `classifyBuffer`）：**

```ts
type Kind = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "cjk" | "binary" | "ascii" | "unknown";
interface Verdict { kind: Kind; encoding: string; ambiguous: boolean; hasFffd: boolean }

function classifyBuffer(B: Buffer, cfg: ResolvedConfig | null): Verdict {
  if (B.length === 0)                  return { kind:"utf8", encoding:"UTF-8", ambiguous:false, hasFffd:false };
  if (startsWith(B, [0xEF,0xBB,0xBF]))  return { kind:"utf8-bom", encoding:"UTF-8", ... };
  if (startsWith(B, [0xFF,0xFE]))       return { kind:"utf16le", encoding:"UTF-16LE", ... };
  if (startsWith(B, [0xFE,0xFF]))       return { kind:"utf16be", encoding:"UTF-16BE", ... };
  if (containsNul(B, /*limit*/8192))    return { kind:"binary", encoding:"BINARY", ... };   // 不转码
  if (isAllAscii(B))                    return { kind:"ascii", encoding:"UTF-8", ... };      // 读写等价，写由配置决定
  if (isValidUtf8Strict(B))              return { kind:"utf8", encoding:"UTF-8", ... };      // ← UTF-8 优先且不可被配置推翻（除非 force）
  // 多字节 CJK 候选（顺序即优先级；单字节编码永不进入此列表 → 性质 P-6）
  const cands = (cfg?.autoCandidates ?? ["GB18030","GBK","GB2312","Big5","Shift_JIS","EUC-KR","EUC-JP"]);
  const pass = cands.filter(e => exactRoundTrip(B, e) && !iconv.decode(B, e).includes("\uFFFD"));
  if (pass.length === 0)                 return { kind:"unknown", encoding:"UNKNOWN", ... };
  const chosen = cfg?.sourceEncoding && pass.includes(normalize(cfg.sourceEncoding))
    ? normalize(cfg.sourceEncoding) : pass[0];
  return { kind:"cjk", encoding: chosen, ambiguous: pass.length > 1, hasFffd:false };
}
```

实现要求：
- `isValidUtf8Strict` 用 `new TextDecoder('utf-8',{fatal:true})`（已验证可用、够快），**整文件**判定，不许只看前缀（性质 P-7）。
- `exactRoundTrip(B,e)` = `Buffer.compare(iconv.encode(iconv.decode(B,e),e), B) === 0`。
- 判定与解码都要对**完整 buffer** 生效；不要抽样（抽样会让"GBK 树里混 UTF-8 文件"这种致命场景失效）。
- `unknown` 时：**读** → 原样透传 buffer，并在结果里追加一行显式警告 `[encoding: UNKNOWN — 未转码，写入将被拒绝]`；**写** → 抛错（闸门 3）。
- 保留上游的图片保护：`detectSupportedImageMimeType(raw)` 命中 → 直接返回原始 buffer，且 `makeReadOperations()` 必须继续提供 `detectImageMimeType` hook（否则 pi 不会走图片分支，模型收到乱码而非图）。

### 3.2 写：编码配置是规范，但"不损坏既有内容"高于配置

**写策略决策矩阵（`resolveWriteEncoding` 必须逐条实现，附优先级）：**

| 磁盘现状 | classify 结果 | 写出编码 | 说明 |
|---|---|---|---|
| 文件不存在（新建） | — | `cfg.writeEncoding ?? cfg.sourceEncoding`，无配置 → UTF-8 | 新文件跟随项目规范 |
| 存在 | `ascii` | 同新建 | **这是关键规则**：ASCII 的 `.java` 里模型新加中文注释 → 必须按项目编码写，否则项目内混入 UTF-8 中文，构建即崩 |
| 存在 | `cjk` | `cfg.writeEncoding ?? cfg.sourceEncoding` | 建议默认 `GB18030`（性质 P-4：对既有 GBK 内容逐字节不变，且能表示生僻字） |
| 存在 | `utf8` / `utf8-bom` | **强制保持 UTF-8（不转 GB）** | 🛡️ **UTF-8 保护规则**：把一个含非 ASCII 的 UTF-8 文件按 GBK 重写是破坏性语义变更。只有该 pattern 配了 `"force": true` 才允许转换，且必须在结果里警告 |
| 存在 | `utf16le/be` | 保持原 UTF-16 | 老 Windows/INI 场景 |
| 存在 | `binary` | 拒绝写入并报错 | 任何情况 |
| 存在 | `unknown` | 拒绝写入并报错 | 除非 `force` |
| 任意 | — | 无 `cfg`（找不到配置文件） | 完全透传，行为与未装扩展逐字节一致（见 §8 A-1） |

- `writeEncoding` 与 `sourceEncoding` 分离：允许"读时兼容 GBK，写时统一 GB18030"。
- **BOM 处理规则（修 §2 缺陷 4）**：`edit` 传进来的 content 可能带前导 `U+FEFF`。若目标编码是 GB 系且 content 以 `U+FEFF` 开头 → **抛错**（提示"该文件是 UTF-8 with BOM，拒绝按 GB 系写出；如确需转换请显式 force 或先转成无 BOM UTF-8"），绝不写入 `0x3F`。若目标是 UTF-8 → 让 BOM 正常编码为 `EF BB BF`。
- **读侧不要剥 BOM**：pi 的 `splitBom` 会自行处理（`edit.js`），我们若先剥离会导致写回时 BOM 静默丢失。
- **行尾**：沿用上游 `detectExistingLineEnding` + `restoreLineEndings`。注意 pi 的 `edit` 内部**已经**恢复过一次行尾，我们再恢复必须是幂等的 → 必须加"双重恢复"测试用例。

### 3.3 三道硬闸门（不可协商、不可关闭的 invariants）

**闸门 1 —— 不可映射字符必须报错，禁止静默变 `?`（修 §2 缺陷 3）**
写出前逐码点校验（已实测可用的实现，直接采用）：
```ts
function unmappableChars(text: string, enc: string): string[] {
  const bad: string[] = [];
  for (const ch of text) {                       // for..of 走码点，正确处理代理对/扩展平面
    const b = iconv.encode(ch, enc);
    if (b.includes(0x3f) || iconv.decode(b, enc) !== ch) { if (!bad.includes(ch)) bad.push(ch); }
  }
  return bad;
}
// 实测：unmappableChars('注释：张䶇（生僻字）𠀋 扩展C','gbk') = ["䶇","𠀋"]
//       unmappableChars(同串,'gb18030')                       = []
//       unmappableChars('OrderService 123\r\n','gbk')          = []   ← 无误报
```
默认 `unmappable: "error"`，错误信息必须包含：**具体字符、U+码点、文件路径、建议改用 GB18030**。策略可配 `"error" | "escape"（转 \uXXXX）| "drop-to-gb18030"（自动升级到 GB18030 并在结果里说明）`。

**闸门 2 —— 写后回读自校验（cheap、可关闭）**
写完后立即 `readFile` → `classifyBuffer` → 断言判定编码 == 期望编码，且 `decode(bytes)` == 期望文本（含不可映射守卫时跳过文本比对）。不一致 → **恢复写前备份 + 抛错**。实现：写前把原 buffer 留在内存，同目录临时文件 `fsync + rename` 原子替换，失败即回滚。

**闸门 3 —— 拿不准就不写**
`unknown` / `binary` / 与配置冲突（UTF-8 文件 vs GB 配置且未 `force`）三种情况一律**拒绝写入并给出下一步指令**，不允许"先写了再说"。

> 设计立场：这套闸门的价值不在于"能处理 GBK"，而在于**把"静默毁数据"变成"响亮失败"**。任何让 agent 能悄悄写坏文件的实现都算未达标。

---

## 4. 配置文件 schema v2（向后兼容上游）

文件名与位置不变：**`.encoding-converter.json`**，就近向上查找（沿用上游 `config.ts`，含目录级 cache 与 overrides 特异性打分）。

```jsonc
{
  "sourceEncoding": "GB18030",        // 读歧义时的优先级 & 新文件/ASCII 文件的写出编码
  "writeEncoding": "GB18030",         // 可选；默认 = sourceEncoding
  "readStrategy": "auto",             // auto(默认)=确定性判定；"config"=强制按 sourceEncoding 解码（仅给判定不了的极端场景）
  "unmappable": "error",              // error | escape | drop-to-gb18030
  "verifyWrite": true,                // 闸门 2 开关，默认 true
  "autoCandidates": ["GB18030","GBK","GB2312","Big5","Shift_JIS","EUC-KR","EUC-JP"],
  "protectUtf8": true,                // UTF-8 文件不被转成 GB（默认 true，强烈建议别关）
  "overrides": [
    { "pattern": "*.properties",  "encoding": "ISO-8859-1", "force": true },
    { "pattern": "docs/**",       "encoding": "UTF-8" },
    { "pattern": "src/test/resources/**", "encoding": "UTF-8" },
    { "pattern": "legacy/**",     "encoding": "GBK" }
  ],
  "confidenceThreshold": 0.8          // 【保留解析、忽略使用】为了不让上游已有配置报错
}
```

要求：
- **任意 iconv 编码都要能用**（修 §2 缺陷 2）：删掉 `isGBEncoding → 一律 UTF-8` 的短路。`force:true` 时跳过自动判定，直接按指定编码解码（单字节编码只能这样用，性质 P-6）。
- overrides 的 `pattern` 语义保持上游行为（裸 glob 走 `matchBase`，特异性打分：字面段 10 > 含通配段 5 > `*` 2 > `**` 1）。
- 无配置 → **一切透传**（这是"项目级/全局安装都安全"的根基，必须用测试锁死）。

---

## 5. 其余功能需求

### 5.1 `grep`：不要污染非 GBK 项目（修 §2 全局副作用）
上游只要 PATH 上有 `rg` 就**无条件替换**全局 `grep`，且 `buildRgArgs()` 不传 `--hidden`（pi 内置传了 → 上游实现搜不到 dotfile / `.github/` / `.mvn/`）、不传 `--json`、硬排除 `.git/.svn/.hg/node_modules`、limit/截断语义不同（作者 README 承认"对齐 built-in 是 planned"）。要求：
- **找不到配置文件时，整体委托内置 grep**（`builtin.execute(...)`），只在真有配置的目录树里用自己的实现。
- 自实现路径补齐 `--hidden`，`.gitignore` 行为与内置一致（rg 默认尊重，别加 `--no-ignore`）。
- 输出格式/limit/截断提示对齐 `core/tools/grep.js` + `truncate.js` 的语义，尽量复用公开导出的 `truncateHead/formatSize/DEFAULT_MAX_BYTES`。
- 多编码分组的"默认组排除 override 目录"逻辑保留（避免重复计数）。
- rg 定位要能命中 **pi 自带的 `~/.pi/agent/bin/rg.exe`**（上游只找 PATH 与 VSCode 的 `@vscode/ripgrep`；本机 pi 把 rg 装在这里，属于免费性能提升）。

### 5.2 系统提示注入：改成条件式（修 §2 全局副作用）
- 上游无条件追加 `ENCODING_NOTE`（约 90 token）到每次 `before_agent_start`。
- 要求：**仅当当前工作目录树内存在 `.encoding-converter.json` 时才注入**；无配置时不注入任何内容（保持纯 UTF-8 项目零污染）。有配置时内容仍是常量（保住 prompt cache）。
- 注进内容要更新：删掉"需要 Python/chardet"的任何暗示，加入"读用确定性判定、UTF-8 文件受保护、不可映射字符会报错"三条，指导模型遇到 `[encoding: UNKNOWN]` 时**停下来问用户**而不是自己 iconv。

### 5.3 `edit` 预览
保留上游 `edit-preview.ts` 的做法（pi 的 `computeEditsDiff()` 绕过 `operations` 且不导出，只能包 `renderCall`）。要求：预览分支的判定必须复用新的 `classifyBuffer`（上游是 `TextDecoder fatal` 的二分判定，会把 ISO-8859 之类误路由）。

### 5.4 保留不动的东西
`read` 的 offset/limit/截断行为、图片链路、`write` 自动建父目录、`edit` 的 mutation queue（`withFileMutationQueue`）、原生 diff/高亮渲染。

### 5.5 P3 可选：`bash`/`powershell` 输出转码
动机：`mvn compile`/`javac`/`type` 的中文输出在 GBK 控制台下照旧乱码（`bash-executor.js:40` 用默认 UTF-8 TextDecoder）。
做法：包 `createBashToolDefinition(cwd,{operations})` 或 `bash_spawn` hook，对 stdout chunk 用同一套判定；难点是**流式跨 chunk 的多字节截断**（参考 pi `output-accumulator.js` 里"跳过 UTF-8 continuation byte"的写法，用 `TextDecoder({stream:true})` 语义）。
风险：可能污染非文本输出、拖慢大输出。**默认关闭**（配置 `transcodeBash: false`），并在文档里写清"这是实验特性"。

---

## 6. 测试规范（必须新增，不接受只跑通上游 60 个）

### 6.1 fixture 生成（提交进仓库 `test/fixtures/`，用脚本生成而非二进制）
```bash
# UTF-8 / GBK / GB18030(4字节扩展) / UTF-8-BOM / UTF-16LE / CRLF版GBK / 纯ASCII .java / 伪二进制 / 真PNG / 混合树
printf '标题：测试文件\n设备名称=温控器A\n' > utf8.txt      && iconv -f UTF-8 -t GBK  utf8.txt > gbk.txt
printf '注释 䶇 𠀋 生僻字\n' > rare.txt && iconv -f UTF-8 -t GB18030 rare.txt > gb18030.txt
printf '\xEF\xBB\xBF标题：测试\n' > utf8bom.txt             && iconv -f UTF-8 -t UTF-16LE utf8.txt > utf16le.txt
```
GBK 文件必须包含：中文注释、中文标识符、`\r\n`、纯 ASCII 行、无 BOM。

### 6.2 必测用例表
| ID | 用例 | 断言 |
|---|---|---|
| T-1 | `classifyBuffer` 对 9 类 fixture | 分类完全符合 §3.1；`unknown` 只在故意构造的非法样本上出现 |
| T-2 | **幂等/无损**：对每个 fixture `read→write`（内容不变） | 输出字节与原文件**逐字节相等** |
| T-3 | **UTF-8 保护**：GBK 配置目录里放 `utf8.txt`，编辑其中 ASCII 片段 | 文件仍是合法 UTF-8，中文仍可读（上游在此场景会毁文件——本次改造的头号回归点） |
| T-4 | ASCII 文件写入中文 | 按 `writeEncoding` 写出（GBK 树里得到 GBK，不是 UTF-8） |
| T-5 | GBK 文件写入生僻字 `䶇` | 闸门 1 抛错且消息含 `䶇 U+4DB7`；`unmappable:"drop-to-gb18030"` 时自动升级且字节合法 |
| T-6 | UTF-8-BOM 文件在 GB 配置下编辑 | 不产生 `0x3F`；BOM 保留 |
| T-7 | CRLF GBK 文件 edit | 仍 CRLF，且**不被双重转换** |
| T-8 | **透传 golden**：无配置目录，扩展加载 vs 不加载 | read/edit/write/grep 结果与字节**完全一致** |
| T-9 | PNG/JPEG/.class/.jar 读取 | 不被转码；模型仍收到 image 附件 |
| T-10 | grep：GBK 目录搜中文命中；无配置目录的点文件仍可搜到 | 与内置 grep 行为对齐 |
| T-11 | `overrides` 特异性 + `force` | `*.properties`→ISO-8859-1 生效（上游不生效） |
| T-12 | 并发写同一文件 | `withFileMutationQueue` 语义不破，无竞态损坏 |
| T-13 | 1MB/10MB 大文件分类耗时 | 单次判定 < 60ms（1MB），带缓存后 < 1ms |
| T-14 | 配置热更新 | 写 `.encoding-converter.json` 后缓存失效（上游已有，保留） |
| T-15 | `readStrategy:"config"` 强制模式 | 明知是 UTF-8 的文件也被按 GB18030 解（行为可控，不是崩溃） |

### 6.3 端到端手工验收（必须真跑 pi 本体，不能只跑 vitest）
在一个真实 GBK 样例仓库里用 pi 执行 `edit` 改中文 → `iconv -f GBK -t UTF-8 文件` 应显示正常中文 → `git diff` 不应出现"整片重写"。

---

## 7. 明确不做（Non-Goals）

- 不做**编码转换/迁移**功能（把整仓转 UTF-8 是另一个决策，见 §9 备选路线）。
- 不改 pi 本体（不 fork pi；`computeEditsDiff` 之类的上游缺陷用扩展层绕过，并可另开 pi issue）。
- 不做 chardet 兼容层（Python 依赖是本次要删的东西）。
- 不做 IDE（VSCode `files.encoding`）配置生成。
- 不承诺 `find`/`ls` 改造（只处理文件名，无编码问题）。
- 不支持 EBCDIC、ISO-2022-JP（转义序列编码无法用"逐字节回环"安全判定）。

---

## 8. 验收标准（全部可量化，逐条附证据）

| # | 标准 |
|---|---|
| A-1 | 无配置目录：扩展加载后 `read/edit/write/grep` 与未加载**逐字节一致**（T-8 golden 测试通过） |
| A-2 | 上游 60 个测试全绿（删掉 detector 相关用例后其余不红） |
| A-3 | §6.2 的 T-1…T-15 全部通过；`npx tsc --noEmit` 无错 |
| A-4 | **仓库内零 Python 引用**：`grep -rn "python\|chardet" src/` 结果为空；`package.json` 无新增运行时依赖（除既有 iconv-lite/micromatch） |
| A-5 | GBK 项目里：编辑中文→`iconv -f GBK -t UTF-8` 可读；`git diff` 不出现整文件重写 |
| A-6 | T-3（UTF-8 保护）与 T-5（不可映射报错）两条"必须毁数据/必须响亮失败"的用例通过 |
| A-7 | 10 万行级 Java 树首次 `read` 平均附加延迟 < 5ms（有缓存），无每文件子进程 |
| A-8 | 系统提示在无配置目录**零增长**（对比注入前后 token 数） |
| A-9 | CI（GitHub Actions：`windows-latest` + `ubuntu-latest`）跑通 vitest + tsc |

---

## 9. 供用户决策的备选路线（写进 README，不要由实现者擅自选）

- **路线 A（本文档）**：磁盘保持 GBK，用扩展把编码差异吃在 IO 层。零侵入、可回退、团队可共享。
- **路线 B**：整仓迁 UTF-8。需要同步改：maven `project.build.sourceEncoding`、`maven-compiler-plugin<encoding>`、`maven-resources-plugin<encoding>`、JSP `pageEncoding`、Tomcat `server.xml URIEncoding`、log4j appender `encoding`、`native2ascii` properties、JDBC `characterEncoding`。收益最大、风险最高（构建/部署链不受控时不可行）。
- **路线 C（低成本中间态，本机已实测）**：`.gitattributes` 写 `*.java text working-tree-encoding=GBK` → **工作树仍 GBK、git blob 存 UTF-8**（实测工作树 `b1ea cce2` / blob `e6a087 e9a298`），于是 `git diff`、GitHub 浏览、blame 中文全部正常。注意：① **不能解决 pi 读文件**（agent 读工作树 → 路线 A 仍必需）；② `text` 属性触发 CRLF 归一（实测有 `LF will be replaced by CRLF` 警告），Windows 老项目需显式 `eol=crlf`；③ 需 `git add --renormalize .`，且团队/CI 必须一致启用；④ 本机 Git-for-Windows 2.45 无 `checkout --iconv`。

---

## 10. 实施分解（按阶段提交，每阶段独立可验收）

**fork 与命名**
- 包名改为 `@yoyo3287258/pi-encoding-fs`（或直接 `pi-encoding-fs-ex`），版本 `0.5.0`；`peerDependencies` 的 `@earendil-works/pi-*` 提到 `>=0.84.0`；`pi.extensions` 仍指 `src/index.ts`。
- 上游 `docs/superpowers/` 那份 design/plan 保留但改名加 `-upstream` 后缀，避免和本文档混淆。

| 阶段 | 内容 | 交付 |
|---|---|---|
| **P0 基线** | 执行 §0.5.2 完成 fork+clone（基线 `main`）；跑通上游 60 测试；README 顶部写"本 fork 与 npm 0.4.0 的差异" | 绿色 CI |
| **P1 判定器** | 新增 `src/encoding/classify.ts`（`classifyBuffer` + 缓存），**删除 `detector.ts`**，重写 `converter.ts`/`resolve.ts` 为 §3.1/§3.2 | T-1…T-7、A-4 |
| **P2 闸门** | 实现闸门 1/2/3（`unmappableChars`、原子写+回读校验、unknown/binary 拒写）+ BOM 规则 | T-5、T-6、A-6 |
| **P3 生态** | grep 条件委托 + `--hidden` + pi 自带 rg；系统提示条件注入；edit-preview 复用判定器；schema v2 + `force` | T-8…T-15、A-1、A-8 |
| **P4 交付** | README 重写（安装/配置/AGENTS.md 模板/混合编码扫描脚本/FAQ）；示例 `.encoding-converter.json`；`CHANGELOG.md` | A-9 + 用户文档 |
| **P5 可选** | §5.5 bash 转码（默认关闭） | 单独 PR |

---

## 11. 开工前必须先向用户确认的问题（不要跳过）

0. **环境前置（不是开放问题，是开关）**：`gh --version` 可用且 `gh auth status` ✓ Logged in？若否，**停下**并让用户执行 §0.5.1（该步骤因 pi bash 工具无交互 stdin 而无法由 agent 代做）。
1. 目标仓库是 **maven 还是 gradle / svn 还是 git**？构建编码能不能改成 **GB18030**（P-4 保证对既有 GBK 源逐字节兼容，是最优解；不能改则默认 `GBK` 并开启闸门 1）。
2. 树里**是否混有 UTF-8/ISO-8859-1 文件**？（决定 `overrides` 清单，也是 T-3 的真实风险面）先让用户跑 §12 的扫描命令。
3. `.properties` / `.xml` / `.sql` / `.jsp` 各自什么编码？（Java `.properties` 规范默认 ISO-8859-1，上游能力覆盖不到）
4. 安装范围：**项目级 `pi install -l` 还是全局**？（本文档推荐项目级，理由见 §5.1/§5.2 的全局副作用）
5. P5（bash 输出转码）要不要做？（老 Java 项目排错时很实用，但有污染非文本输出的风险）

---

## 12. 附录：证据与复现命令（新机器可直接跑）

```bash
# 0) 环境自检
node -e "console.log(process.version)"                     # v24.19.0
node -e "try{Buffer.from('中','gbk')}catch(e){console.log(e.code)}"   # ERR_UNKNOWN_ENCODING → Node 无 GBK 编码器，iconv-lite 必需
node -e "console.log(new TextDecoder('gbk').decode(require('fs').readFileSync('gbk.txt')).slice(0,6))"  # 标题：测试 → 解码侧内置 ICU 可用（但不用它做判定）
python --version                                            # 预期不可用 → 上游退化场景

# 1) 造 GBK 样本并证明它不是合法 UTF-8
printf '标题：测试文件\n设备名称=温控器A\n报警阈值=85.5\n' > utf8.txt && iconv -f UTF-8 -t GBK utf8.txt > gbk.txt
xxd gbk.txt | head -1        # b1ea cce2 a3ba ... = "标题："
node -e "const b=require('fs').readFileSync('gbk.txt');try{new TextDecoder('utf-8',{fatal:true}).decode(b);console.log('valid utf8')}catch(e){console.log('NOT valid utf8 → 判定为 GBK')}"

# 2) 复现事故（证明"静默毁数据"是真的，也是本项目的存在理由）
cp gbk.txt gbk_edit.txt      # 用 pi 的 edit 工具把 "=85.5" 改成 "=90.0" → 报告成功
xxd gbk_edit.txt | head -1   # efbfbd efbfbd ... U+FFFD；46B → 94B；原中文不可恢复

# 3) 扫描真实项目里的混合编码（问用户问题 2 之前先跑这个）
find src -name '*.java' | while read f; do iconv -f GBK -t UTF-8 "$f" >/dev/null 2>&1 || echo "非GBK: $f"; done

# 4) 上游体检（fork 前必做）
git clone https://github.com/yoyo3287258/pi-encoding-fs && cd pi-encoding-fs
git log --oneline -3          # HEAD 应为 69e4e47 fix(read): preserve images（npm 0.4.0 = 162bb04，缺这个修复）
npm i && npx vitest run       # 60 passed
npx tsc --noEmit              # 无错
grep -rn "python\|chardet" src/   # 记录 P1 完成前的基线命中数，P1 后必须为 0
```

### 实测事实速查（写代码/写测试时直接引用）
```
GBK 字节 b1ea cce2 a3ba ...  → iconv 'gbk'/'gb18030' 解码均为「标题：测试文件」，回环逐字节相等
UTF-8 字节 e6a087 ...        → 按 'gbk' 解出「鏍囬锛氭祴璇曟枃浠」，回环不相等（→ 可确定性识别）
231B 真实感 GBK Java 源       → fatal UTF-8 解码失败（validUtf8=false）→ 判定链第 5 步不会误放行
iconv.encode('\uFEFF'+'标题','gbk') → 首字节 0x3F（BOM 变问号，缺陷 4）
iconv.encode('䶇','gbk')            → 0x3F（生僻字变问号，缺陷 3）；'gb18030' 无损
iso-8859-1 / windows-1251 对 0x00-0xFF 全字节回环相等 → 单字节编码只能 force（性质 P-6）
rg --encoding gbk -e "报警" gbk.txt → 命中；不带 --encoding 则 exit=1 搜不到
pi 自带 rg 路径：~/.pi/agent/bin/rg(.exe)
```

---

### 本文档里所有"已实测"结论的产生方式
在本机 `D:/develop/pi/test/enc-test/` 用 Node 24 + `iconv-lite@0.6.3` 实跑得到；上游行为判定来自阅读 `15wtyuan/pi-encoding-fs@main` 源码与 `v0.4.0` 的 `git show` 对比，并在本机跑通其 `vitest`（60 绿）与 `tsc`。若下一会话的机器上 Python 意外可用，§2 缺陷 1 的表现会不同（chardet 会生效），但**判定逻辑仍必须替换为确定性方法**——因为 chardet 的 `confidence` 不可复现、每个文件 spawn 一次 python 不可接受，且它在"GBK 树里的 UTF-8 文件"这一最危险场景上没有任何保证。
