# P0 基线记录（2026-08-27，本机 Windows 11 / Node v24.19.0 / pi 0.84.3）

对应需求文档 §0.5.2 与 §10「P0 基线」。

## 环境
- `gh version 2.98.0`；`gh auth status` ✓ Logged in as `yoyo3287258`（token scopes 含 `repo`）
- §0.5.0 已执行：`gh config set git_protocol https --host github.com` + `gh auth setup-git`
  → `credential.https://github.com.helper = gh auth git-credential`；`git ls-remote https://github.com/15wtyuan/pi-encoding-fs HEAD` 免密返回 sha
- `python --version` → pyenv「No global/local python version has been set yet」→ **上游 detector.ts 在本机 100% 退化为 `{encoding:null, confidence:0}`（§2 缺陷 1 实证）**
- pi 自带 rg：`~/.pi/agent/bin/rg.exe`（且在 PATH 上，`which rg` 命中）

## fork / 基线
- fork: `yoyo3287258/pi-encoding-fs`（isFork=true, parent=15wtyuan/pi-encoding-fs, default branch main）
- 工作目录 = `D:/develop/pi/pi-encoding-fs`（origin=fork，upstream=原作者）
- 基线 HEAD = `69e4e47 fix(read): preserve images when overriding Pi read ops` ✅（npm 0.4.0 = `162bb04`，缺此修复）
- 工作分支 = `feat/deterministic-classify`

## 绿色基线
```
npm i            → 成功（npm audit 6 vulns，未处理；esbuild 等 install scripts 被 allowScripts 拦截，vitest 仍可用）
npx vitest run   → Test Files 8 passed (8) / Tests 60 passed (60)  Duration 29.74s
npx tsc --noEmit → 无错误
```

## P1 前 python/chardet 命中基线（P1 后必须为 0，§8 A-4）
```
src/edit-preview.ts:128:// (chardet spawns python). Instead we use the byte-level fact that GB18030/GBK
src/encoding/detector.ts:9:let _pythonCmd: string | null = null;
src/encoding/detector.ts:12:  if (_pythonCmd) return _pythonCmd;
src/encoding/detector.ts:13:  for (const cmd of ["python3", "python", "py"]) {
src/encoding/detector.ts:16:      _pythonCmd = cmd;
src/encoding/detector.ts:26:  _pythonCmd = null;
src/encoding/detector.ts:30:  "import chardet, sys, json",
src/encoding/detector.ts:37:  "            r = chardet.detect(data)",
src/encoding/detector.ts:44:  let pythonCmd: string;
src/encoding/detector.ts:46:    pythonCmd = await findPython();
src/encoding/detector.ts:52:    const proc = spawn(pythonCmd, ["-c", PY_SCRIPT, filePath]);
src/resolve.ts:23:  // Config explicitly non-GB (e.g. UTF-8 override) -> trust config, skip chardet.
```
共 12 行，其中 `src/encoding/detector.ts` 10 行（整文件删除）、
`src/edit-preview.ts:128` 与 `src/resolve.ts:23` 各 1 行注释（P1 一并改写措辞，否则 A-4 的 grep 不为空）。

## §3.1 性质在本机复跑确认（Node 24 + iconv-lite 0.6.3）
```
P-1 真实 GBK 样本(46B) 合法UTF-8?  false                     ✓
P-2 utf8.txt 按 gbk 回环相等?       false                     ✓
P-3 gbk.txt gbk/gb18030 回环相等?   true / true，无 U+FFFD     ✓
P-4 gbk.txt 经 GB18030 逐字节不变?  true                      ✓
P-6 iso-8859-1 / windows-1251 对任意字节回环相等? true / true  ✓（故禁入自动判定候选）
事故复现：gbk_edit.txt = 94B、validUtf8=true、含 U+FFFD        ✓（§1 静默毁数据）
缺陷4：iconv.encode('\uFEFF'+..,'gbk') 首字节 = 0x3f            ✓
缺陷3：'注释：张䶇（生僻字）𠀋 扩展C' 在 gbk 下不可映射 = ["䶇","𠀋"] ✓
```

## 上游现状补充（读码结论，供 P1–P3 参考）
- `src/config.ts` 的 override 规则字段是 **`sourceEncoding`**；需求文档 §4 schema v2 用的是 **`encoding`** → P3 实现时两个键都接受（`encoding` 优先，`sourceEncoding` 兼容旧配置）。
- 上游 `src/` 实测行数合计 1155（`detector.ts` 71 行）。
- 仓库内**没有** `.github/workflows`（§0.5.3 假定的 `ci.yml` 不存在）→ fork 自建 `.github/workflows/ci.yml`（本次 P0 已加，含 A-4 的 CI 侧守门）。
