# pi-encoding-fs

Encoding-aware `read` / `write` / `edit` / `grep` for [Pi](https://github.com/earendil-works).
Transparently handles GB18030 / GBK / GB2312 files while preserving Pi's native TUI
(diff view, syntax highlighting, line numbers).

## How it works

The extension registers tools with the same names as Pi's built-ins, overriding them.
`read`/`write`/`edit` reuse Pi's own tool skeletons via `createXxxToolDefinition`, injecting
encoding conversion only at the byte-IO layer, so Pi keeps computing and rendering diffs in
UTF-8. `grep` is self-implemented so it can search Chinese text inside GB-encoded files.

Encoding is decided **per file**: the extension walks up from the file's directory to the
nearest `.encoding-converter.json`. If none is found, it passes through as plain UTF-8
(identical to not having the extension installed).

The extension also injects a short note into the system prompt so the agent knows the
built-in tools already handle GB↔UTF-8 transcoding (no need to run `iconv` or re-save
files), and — when no config exists — how to create a `.encoding-converter.json` itself
if it ever reads garbled Chinese. The note is constant so prompt caching stays effective.

## Configuration

Place `.encoding-converter.json` in any directory. It applies to files at or below it,
unless a deeper config overrides it.

```json
{
  "sourceEncoding": "GB18030",
  "confidenceThreshold": 0.8,
  "overrides": [
    { "pattern": "docs/**", "sourceEncoding": "UTF-8" },
    { "pattern": "legacy/**", "sourceEncoding": "GBK" }
  ]
}
```

- `sourceEncoding`: default encoding when detection is uncertain; also used for new files.
- `confidenceThreshold`: minimum chardet confidence (0-1) to trust auto-detection.
- `overrides`: glob rules relative to the config file's directory; most specific wins.

## Requirements

- A [Pi](https://github.com/earendil-works) agent (peer dependency; `>=0.80.0`).
- Encoding detection (for `read`/`write`/`edit`) uses Python 3 + `chardet` when available.
  If Python is missing, the extension silently falls back to `sourceEncoding` from config.
- `grep` uses [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for fast,
  encoding-aware search. If `rg` is not found on `PATH`, `grep` transparently
  falls back to Pi's built-in grep (which cannot search inside GB-encoded files).

## Install

From npm:

```bash
pi install npm:pi-encoding-fs
```

From git:

```bash
pi install git:github.com/15wtyuan/pi-encoding-fs
```

## Notes / limitations

- Only `read` / `write` / `edit` / `grep` are overridden. `bash`, `find`, and `ls` are not
  touched (e.g. a `cat` inside `bash` won't decode GB files).
- `grep` shells out to `ripgrep` with `--encoding` per encoding group (derived from the
  nearest `.encoding-converter.json`), so searching Chinese inside GB18030 files is both
  correct and fast. It excludes `.git` / `.svn` / `.hg` / `node_modules` by default.
  Honoring `.gitignore` and aligning match limits with Pi's built-in grep are planned.

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
