# 读文件 Tool：OpenCode / Codex / Pi 实现对比

## 范围

本文回答 [决策：读文件 Tool 的参数与截断规则](https://github.com/weiguangchao/susan/issues/5) 的前置调研问题：OpenCode、Codex、Pi 当前如何设计模型可用的读文件能力，尤其是参数、分页、截断、路径、错误与二进制处理。

调研只使用官方仓库源码，不使用二手文章。固定提交如下（均为 2026-09-02 快照）：

- OpenCode：[`anomalyco/opencode@8e0f1c253b6b7292b419505af849d06747c0e049`](https://github.com/anomalyco/opencode/tree/8e0f1c253b6b7292b419505af849d06747c0e049)
- Codex：[`openai/codex@ddf8a67ab09cd76b8adc0969f11ee1271179aba7`](https://github.com/openai/codex/tree/ddf8a67ab09cd76b8adc0969f11ee1271179aba7)
- Pi：[`earendil-works/pi@b8b873b9872db04a938fb4357b5e8e824ddc051c`](https://github.com/earendil-works/pi/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)

## 结论速览

| 维度 | OpenCode | Pi | Codex |
| --- | --- | --- | --- |
| 模型侧入口 | 专用 `read` Tool | 专用 `read` Tool | 无专用读文件 Tool；通用 `exec_command`，由 shell 命令读取 |
| 参数 | `path`、`offset`、`limit` | `path`、`offset`、`limit` | `exec_command` 为 `cmd`、`workdir`、输出预算等；另有 app-server `fs/readFile` 只收绝对 `path` |
| 分页语义 | `offset` 1-based 行号；`limit` 最大行数，默认/上限 2000 | `offset` 1-based 行号；`limit` 最大行数，整体仍受 2000 行/50KB 截断 | 模型层由 `sed`/`rg` 等命令自行表达；内部流式读取支持 byte offset/length |
| 默认截断 | 2000 行或 50KB，先到为准；单行 2000 chars | 2000 行或 50KB，先到为准；不返回半行 | `exec_command` 有输出 token budget；app-server 全量读取上限 512MiB，流式 chunk 1MiB |
| 结果形态 | 结构化 `TextPage`：`content`、`offset`、`truncated`、`next` | 文本内容后追加可行动提示，如 `Use offset=... to continue` | 命令输出文本；app-server 返回 `dataBase64` |
| 路径 | 相对路径按当前 location；工作区外绝对路径需 external_directory approval | 相对路径按 cwd；也接受绝对路径 | shell 由进程 cwd 决定；app-server schema 要求绝对路径 |
| 二进制/图片 | 支持指定图片；其他二进制或非法 UTF-8 报错 | 支持图片附件；非图片二进制无专门拒绝，按 UTF-8 解码 | shell 原样输出字节流；app-server 支持任意 bytes 并 base64 返回 |
| 错误 | ToolFailure，含 typed error message | throw 原始 access/read/offset 错误 | 命令 exit/stderr 或 JSON-RPC/io error |

## OpenCode

OpenCode 的当前核心实现把 `read` 注册为专用 Tool。参数为 `path`、`offset`、`limit`；`offset` 描述为 1-based 文本行或目录项起点，`limit` 为最大行数/目录项数。来源：[`read.ts#L16-L28`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read.ts#L16-L28)。

Tool description 明确：可读文本或指定图片、按行 offset 分页、可列目录；相对路径按当前 location 解析，location 内绝对路径可用，location 外绝对路径需要 `external_directory` approval。来源：[`read.ts#L40-L44`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read.ts#L40-L44)。

截断常量为：

- `MAX_READ_LINES = 2000`
- `MAX_READ_BYTES = 50 * 1024`
- 单行 `MAX_LINE_LENGTH = 2000`
- 图片 ingestion 上限 `20MiB`

来源：[`read-filesystem.ts#L11-L15`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read-filesystem.ts#L11-L15)。

输出 schema 是结构化分页对象：`TextPage` 包含 `content`、`mime`、`offset`、`truncated`、可选 `next`；`ListPage` 包含 entries、`truncated`、可选 `next`。分页输入要求 `offset` 为正整数，`limit` 为不超过 2000 的正整数。来源：[`read-filesystem.ts#L72-L91`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read-filesystem.ts#L72-L91)。

读取流程先 `realPath`、打开文件并确认类型；图片按 magic bytes 识别并受 20MiB 限制；PDF 与常见压缩/可执行扩展直接判为 binary。超过 50KB 或显式传入分页参数时进入按行分页；`offset` 默认 1，`limit` 默认/封顶 2000。来源：[`read-filesystem.ts#L171-L214`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read-filesystem.ts#L171-L214)、[`read-filesystem.ts#L233-L319`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read-filesystem.ts#L233-L319)。

错误模型是 typed error：`BinaryFileError`、`MalformedUtf8Error`、`OffsetOutOfRangeError`、`PathKindError`、文件系统错误等，再映射为 ToolFailure。来源：[`read-filesystem.ts#L17-L70`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read-filesystem.ts#L17-L70)、[`read.ts#L94-L104`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/tool/read.ts#L94-L104)。测试覆盖 missing、wrong kind、binary、malformed UTF-8、offset out of range 与截断 `next`。来源：[`tool-read-filesystem.test.ts#L19-L100`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/test/tool-read-filesystem.test.ts#L19-L100)。

## Pi

Pi 的 harness `read` Tool 参数同样是 `path`、`offset`、`limit`；`path` 描述为相对或绝对路径，`offset` 为 1-based 行号，`limit` 为最大行数。来源：[`read.ts#L16-L24`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/tools/read.ts#L16-L24)。

Tool description 明确输出按 2000 行或 50KB 先到为准截断，并用 `offset`/`limit` 读取大文件。来源：[`read.ts#L45-L55`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/tools/read.ts#L45-L55)。截断工具的默认值同样是 2000 行与 50KB，且 head 截断不返回半行。来源：[`truncate.ts#L1-L13`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/utils/truncate.ts#L1-L13)、[`truncate.ts#L71-L76`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/utils/truncate.ts#L71-L76)。

执行时先把路径解析为绝对路径；相对路径按 cwd/execution env 解析。来源：[`path-utils.ts#L44-L50`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/tools/path-utils.ts#L44-L50)。随后检查可读性，读取 bytes；图片按 MIME 转成 image content，文本再切行。`limit` 先截出用户请求的行窗口，但整体仍经过 2000 行/50KB 的 `truncateHead`。来源：[`read.ts#L53-L97`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/tools/read.ts#L53-L97)。

截断提示是追加到内容后的自然语言元数据：

- 行数截断：`[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]`
- 字节截断：`[Showing lines 1-N of M (50KB limit). Use offset=... to continue.]`
- 单行超过 50KB：返回空内容并提示用 shell 命令读取该行前 50KB

来源：[`read.ts#L97-L141`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/harness/tools/read.ts#L97-L141)。

错误处理是直接 throw：不存在文件测试期待 `ENOENT|not found`，offset 超界返回 `Offset ... is beyond end of file (...)`。来源：[`tools.test.ts#L94-L98`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/test/tools.test.ts#L94-L98)、[`tools.test.ts#L176-L183`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/test/tools.test.ts#L176-L183)。

值得注意：Pi 对图片有专门识别和附件通道；但非图片二进制没有 OpenCode 那种 NUL/非打印比例/非法 UTF-8 拒绝逻辑，而是用 Node UTF-8 解码。测试确认图片按 magic bytes 识别并输出 image block。来源：[`tools.test.ts#L200-L219`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/test/tools.test.ts#L200-L219)。

## Codex

Codex 当前模型侧不是用专用 `read` Tool 读文件。核心 Tool handler 集合包含 `exec_command`、`write_stdin`、`apply_patch`、`view_image`、MCP/插件等，未见模型侧 `read_file` handler。`exec_command` 的参数是 `cmd`、`workdir`、`tty`、`yield_time_ms`、`max_output_tokens` 等；输出说明中包含 exit code、session id、original token count 和可能截断的 output。来源：[`shell_spec.rs#L35-L64`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/core/src/tools/handlers/shell_spec.rs#L35-L64)、[`shell_spec.rs#L95-L113`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/core/src/tools/handlers/shell_spec.rs#L95-L113)。

基础提示词要求搜索时优先 `rg` / `rg --files`，并禁止用 Python 输出大块文件。来源：[`default.md#L264-L265`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/protocol/src/prompts/base_instructions/default.md#L264-L265)。因此在模型层，文件读取由 shell 命令自行选择 `sed`、`rg`、`head` 等，没有统一的行/字节 Tool schema。

Codex 另有 app-server 文件接口，不能与模型 Tool 混为一谈：`fs/readFile` 只接收绝对 `path`，响应为 `dataBase64`。来源：[`FsReadFileParams.json#L9-L24`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/app-server-protocol/schema/json/v2/FsReadFileParams.json#L9-L24)、[`FsReadFileResponse.json#L3-L14`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/app-server-protocol/schema/json/v2/FsReadFileResponse.json#L3-L14)。处理器读取 bytes 后 base64 返回。来源：[`fs_processor.rs#L64-L76`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/app-server/src/request_processors/fs_processor.rs#L64-L76)。

文件系统层有两条边界：

- 全量 `read_file` 有 512MiB 上限，超过返回 `file is too large to read`。来源：[`local_file_system.rs#L45-L50`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/exec-server/src/local_file_system.rs#L45-L50)、[`local_file_system.rs#L581-L605`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/exec-server/src/local_file_system.rs#L581-L605)。
- 流式读取以 1MiB chunk 为上限；`ExecutorFileSystem::read_file_stream` 返回不超过 `FILE_READ_CHUNK_SIZE` 的 chunks。来源：[`lib.rs#L34-L35`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/file-system/src/lib.rs#L34-L35)、[`lib.rs#L492-L508`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/file-system/src/lib.rs#L492-L508)。

执行服务器内部还存在打开句柄后按 byte `offset`/`len` 读取的 `read_block` 机制，`len` 必须在 1..1MiB，结果带 `eof`。来源：[`file_read.rs#L46-L58`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/exec-server/src/file_read.rs#L46-L58)、[`file_read.rs#L82-L119`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/exec-server/src/file_read.rs#L82-L119)。这证明 Codex 并非没有分页读取能力，而是把它放在执行环境/app-server 层，而不是当前模型 Tool 面。

## 对 Susan 的启示

1. **`path + offset + limit` 是专用读文件 Tool 的主流形态。** OpenCode 与 Pi 都选择 1-based 行号 offset 和行数 limit；这直接解决“截断后如何继续读”的问题。
2. **2000 行 / 50KB 是两个独立实现的高度一致默认值。** 它们按“先到为准”控制上下文成本，且避免读取超大文件。
3. **单行防御有分歧。** OpenCode 截断到 2000 chars；Pi 保持完整行，若第一行超过 50KB 则返回可行动提示。Susan 若没有 grep/bash Tool，不能沿用 Pi 的“交给 bash” fallback。
4. **结果元数据有分歧。** OpenCode 用结构化 `next`；Pi 用文本提示。对 TUI 展示和模型续读来说，结构化 `next` 更稳，但实现略多。
5. **路径规则必须显式决定。** OpenCode/Pi 都允许相对路径按 cwd；但 Susan 地图已定“任意绝对路径可读”。若继续坚持绝对路径，应拒绝相对路径，避免启动目录影响行为。
6. **二进制处理必须显式决定。** OpenCode 的“图片附件 + 其他二进制报错”比 Pi 的“图片附件 + 其他二进制按 UTF-8 替换解码”更可预测；Codex app-server 则用 base64 支持任意 bytes。
7. **Codex 的 shell-mediated 方案不适配 Susan v1。** Susan v1 只有网络搜索与读文件两个 Tool，没有通用 shell Tool；专用 `read` 更符合范围。
