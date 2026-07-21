# pi-encoding-fs 设计文档

**日期：** 2026-07-21
**状态：** 设计已确认，待评审
**关系：** 全新独立仓库。现有 `filesystemex`（MCP 服务器 `encoding-aware-fs`）仅作参考，不改动。

## 目标

为 **Pi 编码代理的内置 `read`/`write`/`edit`/`grep` 工具** 提供编码感知能力，使 Pi 在
GB18030/GBK/GB2312 混合编码的项目里能透明地正确读写，无需人工干预、无需 agent 主动选择特殊工具。

核心诉求：

1. **完全透明（方案 A）**：agent 照常调用 Pi 原生工具名（`read`/`write`/`edit`/`grep`），
   编码转换在背后发生。工具名不变，agent 与用户均无感知。
2. **保留 Pi 原生 TUI 能力**：特别是 `edit`/`write` 的 **diff 渲染**、语法高亮、行号。
   通过复用 Pi 自身的工具骨架实现，而非从零手写渲染。
3. **标准 Pi 包**：以正常 Pi 扩展包形态发布，用户通过 `pi install` 安装。

## 关键技术机制

Pi 不允许扩展替换内置工具的“实现字节层”，但提供两个恰好契合的机制：

### 1. 同名工具覆盖（Tool Override）

扩展注册一个与内置工具**同名**的工具（`read`/`write`/`edit`/`grep`），即可替换内置实现。
Pi 官方支持此模式（见 `examples/extensions/tool-override.ts`）。

### 2. 工具工厂 + 可插拔 operations

Pi 导出工具工厂函数，接受可插拔的 `operations`（原用于 SSH 远程执行）：

- `createReadTool(cwd, { operations: ReadOperations })`
- `createWriteTool(cwd, { operations: WriteOperations })`
- `createEditTool(cwd, { operations: EditOperations })`
- `createGrepTool(cwd, { operations: GrepOperations })`

`operations` 是“底层如何读/写字节”的钩子。我们在此层注入编码转换：Pi 的骨架始终在
**UTF-8 文本世界**里工作（find/replace、diff 计算、渲染），编码转换发生在它脚下。

### 3. 渲染继承（按槽位自动）

若覆盖工具**不提供** `renderCall`/`renderResult`，Pi **自动复用内置渲染器**——
语法高亮、行号、**edit/write 的 diff 显示** 原样保留。这是保住 diff 观感的关键。

### operations 接口（已核实）

```ts
interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}
interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}
interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string; // 仅用于上下文行显示
}
```

## 架构

```
pi-encoding-fs/                         (新独立仓库，标准 Pi 包)
├── package.json                        keywords: pi-package / pi-extension
│                                       pi.extensions: ["./src/index.ts"]
│                                       peerDependencies: @earendil-works/pi-coding-agent,
│                                                         @earendil-works/pi-ai, @earendil-works/pi-tui
│                                       dependencies: iconv-lite, chardet, micromatch
├── src/
│   ├── index.ts                        扩展入口（见下）
│   ├── encoding/                       ← 从 filesystemex 移植（参考）
│   │   ├── detector.ts                 编码检测（chardet + BOM）
│   │   ├── converter.ts                GB ⇄ UTF-8 编解码
│   │   └── line-endings.ts             CRLF/LF 保持
│   ├── config.ts                       .encoding-converter.json 加载 + 目录级 override 解析
│   ├── path-validation.ts              路径校验（移植）
│   └── grep.ts                         G2：自实现的编码感知 grep execute
└── test/                               vitest
```

## 扩展入口行为（src/index.ts）

配置**每次 `session_start` 重读**（`/reload` 生效）。

```
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    1. 读取 ctx.cwd/.encoding-converter.json
    2. 若【不存在】 → 不注册任何工具，直接返回
         → Pi 使用其内置 read/write/edit/grep（P2 透传）
    3. 若【存在】 → 注册 4 个同名覆盖工具：

       read  = createReadTool(cwd,  { operations: 编码感知 readOps })
       write = createWriteTool(cwd, { operations: 编码感知 writeOps })
       edit  = createEditTool(cwd,  { operations: 编码感知 editOps })
         → 均不提供 renderCall/renderResult → 继承 Pi 内置渲染（diff/高亮/行号）
       grep  = 自实现 execute（G2，能搜 GB 文件中的中文）
  });
}
```

> 注：`pi.registerTool()` 可在 `session_start` 中调用并即时生效。重读配置时需处理
> “上次注册了、这次配置消失”的场景（用 `pi.setActiveTools()` 或重新注册透传壳）——
> 实现计划阶段确定具体做法。

## operations 三个注入点

| 工具 | 注入点 | 行为 |
|------|--------|------|
| read | `readFile(path) → Buffer` | 检测编码 → 解码为 UTF-8 → **重新编码为 UTF-8 Buffer 返回**（Pi 后续按 UTF-8 解得正确文本）。行号/图片检测/截断均由 Pi 完成。 |
| write | `writeFile(path, utf8content)` | 检测目标文件原编码 + 原行尾（新文件用配置默认）→ 转成 GB 字节、还原行尾写盘。 |
| edit | `readFile → Buffer` + `writeFile → string` | read 端解码为 UTF-8，write 端编码回 GB。Pi 在中间用 UTF-8 做 find/replace + **diff 计算与渲染**。 |

## grep（方案 G2：自实现）

**背景取舍：** `GrepOperations` 只暴露 `isDirectory` 和 `readFile`（用于显示上下文行），
**不暴露“实际搜索”钩子**——搜索由 Pi 内部 ripgrep 完成。因此 Pi 的 grep 骨架
**无法透明搜索 GB 文件内部的中文**（UTF-8 pattern 匹配不到 GB 编码字节）。

由于“能搜到 GB 文件里的中文”是本工具的核心价值，且 grep 结果本就无 diff（自渲染损失极小），
grep 采用 **G2：脱离 Pi 骨架、自实现 `execute`**，移植 filesystemex 现有 grep 逻辑
（UTF-8 pattern 转成目标编码再喂 grep/ripgrep，结果转回 UTF-8）。

read/write/edit 走 Pi 骨架（与 grep 无关，diff 全保留）。

## 编码启用逻辑（P2：仅配置存在时接管）

- 仅当项目根存在 `.encoding-converter.json` 时接管；否则完全透传给 Pi 内置工具。
- 沿用 filesystemex 现有检测策略（3a，不改动）：
  - 显式配置 / 目录级 override 优先。
  - 否则 chardet 检测；低于 `confidenceThreshold` 回落到 `sourceEncoding`。
  - 已处理“chardet 常把 UTF-8 中文误判成 GBK/GB2312”的坑：非 GB 目标编码直接走 UTF-8，跳过 chardet。

### 配置文件格式（沿用现有）

```json
{
  "sourceEncoding": "GB18030",
  "confidenceThreshold": 0.8,
  "overrides": [
    { "pattern": "openspec/**", "sourceEncoding": "UTF-8" },
    { "pattern": "legacy/**", "sourceEncoding": "GBK" }
  ]
}
```

- `sourceEncoding`：检测不确定时的默认编码，也用于新建文件。
- `confidenceThreshold`：chardet 自动检测的最小置信度（0–1）。
- `overrides`：目录/文件级 glob 规则，最具体的匹配优先。

## 安装与分发

- 标准 Pi 包：`keywords` 含 `pi-package`/`pi-extension`，`pi.extensions` 声明入口。
- 用户通过 `pi install <npm 或 git>` 安装，Pi 自动发现扩展入口。
- **无需自定义 installer**（区别于 filesystemex 的 MCP installer）。
- Pi 运行时依赖放入 `peerDependencies`；`iconv-lite`/`chardet`/`micromatch` 等放 `dependencies`。

## 范围外（YAGNI）

- 不覆盖 `bash`、`find`、`ls`（bash 命令千变万化，透明化得不偿失）。
- 不做交互式安装向导。
- grep 不做 diff（本无此概念）。
- 不修改现有 filesystemex 仓库。

## 待实现阶段确认的细节

- `session_start` 重读配置时，如何从“上次接管、这次配置消失”干净回退到内置工具
  （`setActiveTools` vs 注册透传壳）。
- `read` operations 返回“重新编码为 UTF-8 的 Buffer”这一路径需针对 Pi 的实际
  Buffer→string 处理验证（编码转换点的正确落位）。
- grep（G2）的结果渲染：使用 Pi 默认文本渲染即可，无需自定义。
