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

- Encoding detection uses Python + `chardet` when available. If Python is missing, the
  extension falls back to `sourceEncoding` from config.

## Install

```bash
pi install <npm-or-git-target>
```
