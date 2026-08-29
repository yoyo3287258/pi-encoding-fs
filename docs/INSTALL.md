# 在另一台机器上安装本扩展

> 下面每条命令都在本机（Windows 11 + pi 0.84.3 + Node 24）真跑过，跑出来的报错原文也照抄了。
> 唯一**还没实测**的是路线 A，因为它要求分支先 push 到 GitHub（见 §6）。

---

## 0. 前置要求

| 要求 | 说明 |
|---|---|
| Node **≥ 22.19.0** | `package.json` 的 `engines` 要求（与 pi 0.84.3 一致）；Node 18 会拒装 |
| pi 已可用 | `pi --version` |
| 能访问 npm registry | 运行时依赖只有 3 个：`iconv-lite` `jsonc-parser` `micromatch` |
| **不需要 Python** | 本 fork 已彻底删除 `chardet` 子进程调用（上游版本必须要 Python） |
| ripgrep | 不用管：pi 自带 `~/.pi/agent/bin/rg.exe`，我们的 `grep` 会自己找到它 |

---

## 1. 路线 A（推荐，需要 push 之后）：从 git 装

```powershell
# 用户级（所有项目生效）
pi install git:github.com/yoyo3287258/pi-encoding-fs@v0.5.0

# 或项目级（写进 <项目>\.pi\settings.json，可以随仓库共享给同事）
cd D:\path\to\your-project
pi install git:github.com/yoyo3287258/pi-encoding-fs@v0.5.0 -l
```

pi 会 clone 到 `.pi/git/github.com/yoyo3287258/pi-encoding-fs`（用户级在
`~/.pi/agent/git/...`），并且**自动跑 `npm install`**（pi 文档承诺的行为，见
`docs/packages.md` 的 git 源一节）→ 依赖不用你管。

⚠️ **两个必须知道的点**

1. **建议钉住 `@v0.5.0`**。fork 的 `main` 已经合进了本套代码（PR #1），所以 `@main` 不再是坑，
   但钉 tag 才能保证你明天重装的还是今天这一版。
2. 换版本用 `pi install git:...@新ref`（更新 settings 里的 pin），或 `pi update git:...`。

---

## 2. 路线 B（现在就能用，离线/内网机器）：拷目录

### 2.1 最快：连 `node_modules` 一起拷

```powershell
# 从这台机器把整个仓库目录拷过去（.git 可以不要）
robocopy D:\develop\pi\pi-encoding-fs  E:\tools\pi-encoding-fs  /MIR /XD .git
cd D:\path\to\your-project
pi install E:\tools\pi-encoding-fs -l
```

### 2.2 干净形态（只有源码）：**必须自己装依赖**

```powershell
cd E:\tools\pi-encoding-fs
npm install --omit=dev          # ← 这一步不能省
```

不装会直接加载失败，报错原文（实测）：

```text
Error: Failed to load extension "E:\tools\pi-encoding-fs\src\index.ts":
Failed to load extension: Cannot find module 'micromatch'
Require stack:
- E:\tools\pi-encoding-fs\src\config.ts
Hint: Start without extensions using "pi -ne".
```

**为什么**：`pi install <本地路径>` 只把路径写进 settings，**不会**替你 `npm install`
（只有 git 源才会）。实测确认过。

另外：`pi install <本地路径>` 写进 `.pi/settings.json` 的是**绝对路径**，
所以这份 settings 不能跨机器照抄，换机器要重新跑一次 `pi install`。

```jsonc
// <项目>\.pi\settings.json 长这样
{ "packages": ["E:\\tools\\pi-encoding-fs"] }
```

---

## 3. 路线 C：npm 包（**尚未发布**）

```powershell
# 本 fork 的包名是 scoped 的（package.json 里已是这个名字）：
pi install npm:@yoyo3287258/pi-encoding-fs@0.5.0 -l
```

**为什么不用裸名 `pi-encoding-fs`**：npm 包名全局唯一，裸名已被上游
（`15wtyuan`，最新 `0.4.0`）占着，我们发不上去；而本 fork 的行为与它并不兼容，
也不应该发到同一个包里混淆用户。所以 `package.json` 的 `name` 已改成
`@yoyo3287258/pi-encoding-fs`。

**仍未发布**：scoped 包得由对应 npm 账号发（`@yoyo3287258` 这个 scope 得先在你的 npm
账号下存在），而且发布就是不可逆的公开动作。要发请明确说一声。在那之前请用路线 A/B。

---

## 4. 装完**必须**做的两步（不做等于没装）

### 4.1 生成配置文件

```powershell
cd D:\path\to\your-project
node E:\tools\pi-encoding-fs\tools\scan-encoding.mjs . --init --dry-run   # 先看建议，不写盘
node E:\tools\pi-encoding-fs\tools\scan-encoding.mjs . --init             # 真写
```

（git 安装的包在 `~/.pi/agent/git/github.com/yoyo3287258/pi-encoding-fs/` 或
`.pi/git/...` 下面，路径自己替换。）

`--init` 的推断优先级（这是它为什么不会瞎猜 GB18030）：

1. **工程自己的声明**：Eclipse `.settings/org.eclipse.core.resources.prefs` 的 `encoding/…`
   （逐目录/逐文件声明会被搬成 `overrides`）、`pom.xml` 的 `project.build.sourceEncoding`、
   gradle `encoding`、`.editorconfig` `charset`、`.gitattributes` `working-tree-encoding`；
2. 没有声明时看**字节事实**（候选唯一的文件）；
3. 还不行（真实工程里中文文本往往全歧义）就取**能覆盖全部观测字节的最窄编码**，
   而不是 GB18030 超集 —— 选超集会静默允许写出 Eclipse/GBK 读不懂的 4 字节序列；
4. 与字节矛盾的声明**不采纳**，只报出来给人看（例：声明 `WebContent` 是 GBK，
   但范围内 1965/2009 个含非 ASCII 文件字节上是 UTF-8）。

行为细节：已有配置时**拒绝覆盖**（退出码 1）；`--force` 才覆盖；`--dry-run` 不碰磁盘。
所有推断依据都会写进配置头部注释（这份配置要进版本库，同事得看懂为什么是这个值）。

手写也行，最小可用配置：

```jsonc
{
  "sourceEncoding": "GBK",       // 你项目的主编码
  "writeEncoding": "GBK",        // 写回同一种编码
  "unmappable": "error",         // 装不下的字直接拒写
  "verifyWrite": true,
  "protectUtf8": true,
  "readStrategy": "auto",
  "overrides": []
}
```

> ⚠️ **没有配置文件时，这个扩展基本是完全惰性的**（这是设计如此：无配置目录要与
> "未装扩展"行为一致）。而 pi 内置 `read` 用的是 `buffer.toString("utf-8")`——**有损、
> 不报错**：实测一份 GBK 文件在没有配置时返回的是
>
> ```text
> /** ???????? */
> ```
>
> 而不是错误。**更糟的是模型不会抱怨**：P5 实测里，模型拿到乱码后自己"脑补"出了通顺的
> 中文注释，还声称"下面是工具结果原样"。
>
> 作为兼道（方案乙），扩展会在**字节不改**的前提下多说一句：读无配置目录里的非 UTF-8 文件
> → 提示它实际是 GBK/GB18030、pi 会静默出乱码、不要照原样写回；改这种文件
> → 提示“本次写入已把它变成 UTF-8”并给出 `svn revert` / `git checkout --` 的补救命令。
> 但提示只能救“已经在跟模型对话”的那一次，**正确做法仍是把配置建起来**。

### 4.2 重启 pi

工具注册发生在启动时。改 `transcodeBash` 尤其需要重启（`/reload` 不够）。

---

## 5. 装完自检（三条，一分钟）

```powershell
# ① 读一个已知 GBK 文件 → 应该出正确中文，且末尾带 [encoding] 说明（若发生过转码）
pi -p --approve --no-session "用 read 读 <某个 GBK 文件>，把内容原样贴出来"

# ② 中文 grep → 内置只能命中 UTF-8 文件，本扩展能命中 GBK 文件
pi -p --approve --no-session "用 grep 在当前目录搜「<一个只存在于 GBK 文件里的中文词>」，只要文件名和行号"

# ③ 写保护：编辑那个 GBK 文件的一个字，然后核对字节数与行尾没变
node E:\tools\pi-encoding-fs\tools\scan-encoding.mjs <那个文件>
```

拿不准项目编码就先画像（不改任何文件）：

```powershell
node E:\tools\pi-encoding-fs\tools\scan-encoding.mjs .            # 全仓画像 + CSV
node E:\tools\pi-encoding-fs\tools\scan-encoding.mjs . --damaged  # 已被毁掉的文件清单
```

---

## 6. 当前分发状态（`v0.5.0`）

| 事项 | 状态 |
|---|---|
| 代码 | PR #1 已合进 fork 的 `main`（merge commit `20237e1`），分支 `feat/deterministic-classify` 同源 |
| tag | **`v0.5.0` 已打并推** → 可以直接 `pi install git:github.com/yoyo3287258/pi-encoding-fs@v0.5.0 -l` |
| GitHub release | 无（只有 tag；需要 release notes 再说一声） |
| npm 发布 | **未做**。`package.json` 已改用 scoped 名 `@yoyo3287258/pi-encoding-fs`（裸名被上游占着），但还没真正 `npm publish`，见 §3 |
| CI（验收 A-9） | ✅ **双 OS 跑绿**；merge 后的 `main`（`20237e1`）上 run 33233103506 也绿，证据见 [ACCEPTANCE.md](./ACCEPTANCE.md) |

要走路线 A，现在拿 `@v0.5.0` 就能装（上面 §1）。另一台机器不能访外网时用**路线 B**。
