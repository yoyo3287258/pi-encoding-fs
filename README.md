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
>
> 因此**不要** `pi install npm:pi-encoding-fs`，请用本仓库（项目级安装，理由见下方 Requirements 与需求文档 §5.1/§5.2）。
> 改造目标、红线与验收标准见仓库根目录 [`REQ-pi-encoding-fs-fork.md`](./REQ-pi-encoding-fs-fork.md)。

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

- Only `read` / `write` / `edit` / `grep` are overridden. `bash`, `find`, and `ls` are not
  touched (e.g. a `cat` inside `bash` won't decode GB files). P5 will look at shell output.
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
- The UTF-8 vs GB decision is a **byte-level** probe (`TextDecoder("utf-8",{fatal:true})`
  throws on GB bytes), mtime-cached. A genuinely single-byte legacy encoding (ISO-8859 /
  Windows-1252) would be treated as non-UTF-8 and routed through the encoding-aware
  preview; this is harmless as long as a matching `.encoding-converter.json` exists.

## License

MIT
