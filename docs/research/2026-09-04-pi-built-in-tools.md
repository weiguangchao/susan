# Pi Agent 七个内置 Tool 的当前契约

## 范围与快照

本文回答 [调研：Pi Agent 七个内置 Tool 的当前契约](https://github.com/weiguangchao/susan/issues/33)：以 Pi 的一手源码为准，核对 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 的模型侧 schema、路径、结果、错误、截断、取消与测试语义，并判断哪些适合成为 Susan 的设计基线。

固定快照为 [`earendil-works/pi@9841914c71a74d81abe07f751aefd271fd924e63`](https://github.com/earendil-works/pi/tree/9841914c71a74d81abe07f751aefd271fd924e63)，提交时间为 2026-09-04。当前发布包是 `@earendil-works/pi-coding-agent` 0.85.0；仓库里的 package metadata 也把它定义为 Pi CLI。来源：[`package.json#L1-L13`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json#L1-L13)。

这里需要先区分两层实现：

- `packages/agent` 的通用 harness 只导出 `read`、`write`、`edit`、`bash` 四个 execution Tool。来源：[`packages/agent/src/harness/tools/index.ts#L1-L23`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/harness/tools/index.ts#L1-L23)。
- `packages/coding-agent` 的 Tool registry 才有本票关注的七个，此外又加入 Windows-only `powershell`；默认 coding 集是 `read/bash/edit/write`，read-only 集是 `read/grep/find/ls`。来源：[`index.ts#L93-L105`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/index.ts#L93-L105)、[`index.ts#L164-L210`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/index.ts#L164-L210)。

因此下文以 `pi-coding-agent` 的七个实现为模型侧基准；harness 层只用于说明哪些行为属于 Pi 的可注入执行架构，而不是七个 Tool 本身的稳定承诺。

## Schema 速览

| Tool | 模型侧参数 | 默认值与模型可见语义 |
| --- | --- | --- |
| `read` | `path: string`；可选 `offset: number`、`limit: number` | `offset` 是 1-based 行号；文本最多 2000 行或 50KB；支持图片附件 |
| `write` | `path: string`、`content: string` | 创建或完整覆盖文件；自动创建父目录 |
| `edit` | `path: string`、`edits: Array<{oldText,newText}>` | 一次修改一个文件；多段 replacement 都对原内容匹配；目标必须唯一且不能重叠 |
| `bash` | `command: string`；可选 `timeout: number` | timeout 单位秒，无默认 timeout；一次性命令 |
| `grep` | `pattern: string`；可选 `path`、`glob`、`ignoreCase`、`literal`、`context`、`limit` | 默认当前目录、regex、区分大小写、0 行 context、100 个 match |
| `find` | `pattern: string`；可选 `path`、`limit` | glob 搜索，默认当前目录、1000 个结果 |
| `ls` | 可选 `path`、`limit` | 默认当前目录、500 个 entry |

这些 schema 直接见各实现：[`read.ts#L15-L19`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/read.ts#L15-L19)、[`write.ts#L12-L15`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/write.ts#L12-L15)、[`edit.ts#L22-L42`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit.ts#L22-L42)、[`bash.ts#L38-L41`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L38-L41)、[`grep.ts#L21-L33`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L21-L33)、[`find.ts#L26-L32`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L26-L32)、[`ls.ts#L11-L14`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/ls.ts#L11-L14)。

Schema 只写 `Number`，没有 integer、minimum 或 maximum 约束。部分实现会在运行时修正或拒绝输入，但并不一致：`bash` 明确拒绝非有限值、非正数和超过 Node timer 上限的 timeout；`grep` 把 limit 钳到至少 1；`read/find/ls` 没有等价的正整数校验。来源：[`bash.ts#L22-L35`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L22-L35)、[`grep.ts#L125-L136`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L125-L136)。Susan 不应复制这种校验不一致。

## 共同契约

### 路径不是 workspace sandbox

七个 Tool 的相对路径都按执行时的 `ctx.cwd`（没有时才用创建 Tool 时的 cwd）解析；绝对路径原样进入解析，`..` 也没有 containment 拒绝。底层解析还会展开 `~`、接受 `file://`、去掉开头的 `@`、规范 Unicode 空格，并在 Windows 转换部分 shell 风格盘符路径。来源：[`path-utils.ts#L31-L48`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/path-utils.ts#L31-L48)、[`paths.ts#L66-L105`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/utils/paths.ts#L66-L105)。测试逐个确认七个 Tool 会优先使用 `ctx.cwd`。来源：[`tools.test.ts#L908-L1011`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/tools.test.ts#L908-L1011)。

这意味着 Pi 的 `cwd` 是相对路径基点，不是权限边界。源码中的七个 Tool 也不包含 approval policy 或 OS sandbox。Susan 可以沿用“相对路径以 cwd 为基点”，但“cwd 外需审批”必须由自己的 Policy/Harness 层实现。

### 结果与错误

成功结果统一是 agent Tool result：`content` 中通常是一段 text，另有可选 `details` 给 TUI/extension 使用；失败通过 throw 表达，不是七个 Tool 自己定义的 typed error union。截断等状态会同时出现在模型可见的文本 notice 和 `details`。例如 `read` 的 `details.truncation`、`grep` 的 `matchLimitReached/linesTruncated`、`find` 的 `resultLimitReached`、`ls` 的 `entryLimitReached` 均是各自接口的一部分。来源：[`read.ts#L28-L30`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/read.ts#L28-L30)、[`grep.ts#L43-L47`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L43-L47)、[`find.ts#L43-L46`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L43-L46)、[`ls.ts#L25-L28`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/ls.ts#L25-L28)。

共享截断默认值是 2000 行、50KB，head 截断不返回半行；bash 用 tail 截断，只有末尾单行本身超过 byte limit 时可能保留该行尾部。来源：[`truncate.ts#L1-L13`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/truncate.ts#L1-L13)、[`truncate.ts#L58-L124`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/truncate.ts#L58-L124)、[`truncate.ts#L126-L198`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/truncate.ts#L126-L198)。

### 取消不是事务回滚

所有实现都接收 `AbortSignal`，但取消强度不同：

- `bash` 在 abort/timeout 时杀进程树；Unix 先杀 detached process group，Windows 调用系统 `taskkill.exe /F /T`。来源：[`bash.ts#L94-L143`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L94-L143)、[`shell.ts#L213-L246`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/utils/shell.ts#L213-L246)。
- `grep/find` 会终止它们启动的 `rg/fd` 子进程，并以 `Operation aborted` 失败。来源：[`grep.ts#L178-L192`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L178-L192)、[`find.ts#L94-L107`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L94-L107)。
- `read/ls` 的本地 fs Promise 不能真正撤销，abort listener 只是尽早 reject/忽略后续结果。来源：[`read.ts#L86-L105`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/read.ts#L86-L105)、[`ls.ts#L72-L84`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/ls.ts#L72-L84)。
- `write/edit` 为同一路径使用 mutation queue，并在每个 await 前后检查 abort；注释明确这样做是为了不在底层写仍可能完成时提前释放队列。因此它们保证并发顺序，不保证取消能回滚已经完成的写。来源：[`write.ts#L66-L90`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/write.ts#L66-L90)、[`edit.ts#L160-L200`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit.ts#L160-L200)。

## 各 Tool 的执行语义

### `read`

`read` 先把整个文件读入内存，再对文本按行切片；`offset` 从 1 开始，超出文件末尾会 throw，`limit` 先选窗口，窗口仍受 2000 行/50KB head 截断。截断后文本末尾给出下一次 `offset`；若第一行本身超过 50KB，则不返回半行，而提示改用 bash。来源：[`read.ts#L127-L178`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/read.ts#L127-L178)。

图片按文件 magic/MIME 识别，支持 jpg/png/gif/webp/bmp，并输出 image content；默认会经 Pi 的 image processor 自动缩放。非图片 bytes 直接 `Buffer.toString("utf-8")`，没有专门的 binary/invalid UTF-8 错误。来源：[`read.ts#L101-L130`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/read.ts#L101-L130)。读路径还会尝试 macOS 截图 AM/PM 空格、NFD 文件名和弯引号变体，这属于 Pi 的交互便利层。来源：[`path-utils.ts#L50-L99`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/path-utils.ts#L50-L99)。

### `write`

`write` 创建父目录后用 UTF-8 `fs.writeFile` 创建或完整覆盖目标，成功文本是 `Successfully wrote to <path>`。它使用 mutation queue，但不是 temp-file + rename 的原子替换。来源：[`write.ts#L28-L38`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/write.ts#L28-L38)、[`write.ts#L45-L90`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/write.ts#L45-L90)。

### `edit`

当前公开 schema 是 batch replacement：`edits[]` 至少一个；各 `oldText` 都针对同一份原文件匹配，应用前会验证所有目标，重复、空目标、重叠、找不到或结果无变化都失败，所以一个 replacement 失败时不会发生部分应用。来源：[`edit.ts#L137-L162`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit.ts#L137-L162)、[`edit-diff.ts#L291-L361`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit-diff.ts#L291-L361)、[`tools.test.ts#L375-L432`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/tools.test.ts#L375-L432)。

不过“exact”并非字节级严格相等：exact miss 后会做 NFKC、逐行 trimEnd、smart quote、dash 与特殊空格归一化，再要求归一化后的目标唯一；同时会保留未触及行的原始内容。来源：[`edit-diff.ts#L27-L54`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit-diff.ts#L27-L54)、[`edit-diff.ts#L201-L250`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit-diff.ts#L201-L250)。此外它将 CRLF/LF 统一匹配后恢复原 line ending，并保留 UTF-8 BOM。成功 details 含展示 diff、standard unified patch 和第一处新行号。来源：[`edit.ts#L186-L212`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit.ts#L186-L212)。

执行前兼容旧模型输出：顶层 `oldText/newText`、单对象 `edits`、JSON string `edits` 会被整理为公开 batch schema；这些是输入修复，不应当出现在 Susan 的正式 schema。来源：[`edit.ts#L104-L141`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/edit.ts#L104-L141)。与 `write` 一样，最终是直接 `writeFile`，不是文件系统事务。

### `bash`

`bash` 是 one-shot command：没有 PTY、持续 session 或后续 stdin schema。Pi 合并 stdout/stderr 到同一到达顺序的流，成功返回文本；无输出返回 `(no output)`。非零 exit code、timeout、abort 都 throw，并把已捕获输出拼进错误文本；成功 details 不含结构化 exit code。来源：[`bash.ts#L38-L53`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L38-L53)、[`bash.ts#L317-L367`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L317-L367)。

输出以 tail 保留最后 2000 行/50KB；一旦截断，完整原始输出 spill 到 OS temp file，并在模型文本与 details 中给出路径。流式 update 会节流。来源：[`bash.ts#L255-L334`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L255-L334)。

Unix 优先 `/bin/bash`，其次 PATH 上的 bash，最后 `sh -c`；Windows 优先 Git Bash，再找 `bash.exe`，找不到即报错。旧 WSL `bash.exe` 用 stdin transport，其他 shell 用 `-c`。来源：[`shell.ts#L12-L21`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/utils/shell.ts#L12-L21)、[`shell.ts#L60-L120`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/utils/shell.ts#L60-L120)。Pi 还默认把 session/model 信息放入 `PI_*` 环境变量，并允许 extension 注入 command prefix、替换 operations 或改写 spawn context，这些都依赖 Pi 自己的 session/extension 架构。来源：[`bash.ts#L166-L204`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/bash.ts#L166-L204)。

### `grep`

默认实现不是 Node 搜索器，而是经 Pi `ensureTool("rg")` 获取 ripgrep；不存在且无法下载时失败。它以 `--json --line-number --hidden` 运行，默认尊重 `.gitignore`，可加 ignore-case、fixed-strings、glob，并在 pattern 前加入 `--` 阻止 flag injection。来源：[`grep.ts#L117-L168`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L117-L168)。

输出为 `relative/path:line: text`；对单文件搜索也保留 basename。context 行用 `path-line- text`。100 是 match 数上限而非输出行上限；context 可能令输出行更多。每一行先截到 500 characters，整体再按 50KB head 截断，notice/details 分别说明 match limit、byte limit 与 long-line truncation。来源：[`grep.ts#L135-L145`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L135-L145)、[`grep.ts#L197-L215`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L197-L215)、[`grep.ts#L263-L309`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/grep.ts#L263-L309)。rg exit 1 被解释为“无匹配”，其他非零为失败。

### `find`

默认实现经 `ensureTool("fd")` 获取 fd；搜索包含 hidden entries、尊重 `.gitignore`。路径型 glob 会启用 `--full-path` 并补 `**/`，Windows 还会兼容两种 separator。来源：[`find.ts#L171-L216`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L171-L216)。输出统一相对 search root 并改为 `/` separator，目录保留 `/` 后缀。来源：[`find.ts#L13-L23`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L13-L23)、[`find.ts#L268-L299`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L268-L299)。

默认 1000 结果，随后仍有 50KB head limit；无结果返回 `No files found matching pattern`。实现允许注入自定义 `glob` operations，此时只硬编码忽略 `node_modules` 与 `.git`，与 fd 的完整 gitignore 行为并不完全相同。来源：[`find.ts#L109-L168`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/find.ts#L109-L168)。

### `ls`

`ls` 只列一层，包含 dotfiles；按不区分大小写的字母序排序，目录加 `/`，无法 stat 的 entry 会静默跳过。不存在、不是目录、无法读取分别抛出可读错误；空目录返回 `(empty directory)`。来源：[`ls.ts#L83-L137`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/ls.ts#L83-L137)。默认最多 500 entries，另受 50KB head limit；达到限制时文本建议把 limit 翻倍，details 记录具体限制。来源：[`ls.ts#L139-L161`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/tools/ls.ts#L139-L161)。

## 当前实现与较早 Pi 材料的差异

仓库已有的 2026-09-02 调研固定在 `b8b873b9...`，并引用 `packages/agent/src/harness/tools/read.ts`。截至本文快照：

1. `read` 的公开 `path/offset/limit` 与 2000 行/50KB 规则没有实质变化；变化主要是 harness execution context 的传递，不应把这种内部签名变化写进 Susan 的 Tool schema。
2. 旧材料只看 harness `read`，不能推出“harness 有七个 Tool”。当前 harness 明确只有四个，而 coding-agent registry 有八个（七个目标加 `powershell`）。Susan 的七个名称应参考 coding-agent registry，执行抽象可以参考 harness。
3. 在旧快照之后，Pi 删除了 `write` 成功消息中的 `${content.length} bytes`，因为 JavaScript string length 是 UTF-16 code units，不是 byte 数；当前只报告目标路径。变更的一手提交：[`e583b290`](https://github.com/earendil-works/pi/commit/e583b290a61e19a6dd6cece5216567a6074cd139)。Susan 若要回报字节数，必须按实际编码后的 bytes 计算，否则应沿用当前 Pi 的简洁文本。
4. coding-agent 最近把 renderer 从执行实现中拆开，但模型 schema 和本文所述核心执行语义仍在各 Tool definition 中。Susan 应吸收这个 seam，而不是复制 Pi 的 Ink/TUI renderer。

旧 npm scope `@mariozechner/pi-coding-agent` 的 0.73.1 与当前 `@earendil-works/pi-coding-agent` 不应混用为同一个“latest”契约；旧 tag 的 package metadata 仍是旧 scope，当前 main 已是新 scope。来源：[`v0.73.1 package.json#L1-L4`](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/package.json#L1-L4)、[`当前 package.json#L1-L4`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json#L1-L4)。本研究只把当前仓库、当前 package scope 和固定 commit 视为 canonical。

## 对 Susan 的建议

### 适合作为基线

1. 固定模型侧名称与核心参数形状；尤其 `read(path, offset, limit)`、`write(path, content)`、`bash(command, timeout)`、搜索 Tool 的专用参数，比让模型拼 shell 更稳定。
2. `edit` 采用一次一文件、多个互不重叠 replacement，并在写前完成全部匹配验证；返回 compact diff/patch 供审批和 TUI 展示。
3. 所有路径先按 invocation cwd 解析，但把解析结果交给 Susan 的 approval policy；cwd 是基点，不是 sandbox。
4. 所有可能大输出统一有明确预算、模型可见 continuation notice 与机器可读 truncation metadata。读文件保留 head，命令保留 tail，是合理默认。
5. one-shot `bash` 首版支持 timeout、合并 stdout/stderr、非零退出失败、abort 杀 process tree；搜索 pattern 一律作为 argv 并用 `--` 隔离，避免 option injection。
6. `write/edit` 对同一路径串行化；取消只能阻止尚未开始的阶段，不能承诺撤销已完成的外部副作用。

### 不应直接照搬

1. 不复制 Pi 的“允许任意绝对路径且无内建审批”；Susan 已决定 cwd 外路径与危险操作由 Policy 审批。
2. 不复制 Pi 的弱数值 schema；offset、limit、context、timeout 应声明并验证为有界正整数（context 可为 0），防止负数、小数和超大请求出现实现相关行为。
3. 不把 `ensureTool` 自动下载 `rg/fd` 当作 Tool 契约。Susan 已倾向 Node/TypeScript 稳定实现；是否使用宿主二进制属于 adapter/性能决定，不能改变匹配、gitignore、排序和错误语义。
4. 不复制 `PI_*` session env、commandPrefix/spawnHook、macOS 截图路径猜测、Pi temp-file 命名或 TUI renderer；它们属于 Pi 产品架构。
5. 不把 Pi 的 fuzzy `edit` 称作“精确替换”。Susan 已决定 exact unique replacement；若未来需要 fuzzy，应作为显式模式和独立决策，而不是 exact miss 后静默放宽。
6. 不宣称 Pi 的 `write/edit` 是原子写。Susan 已决定原子替换，需自行设计同目录临时文件、权限/metadata、fsync/rename 与 Windows 行为。
7. 不照搬 bash 的结果缺口。Susan 已决定结构化 exit code/stdout/stderr；Pi 把 stdout/stderr 合并且成功 details 不含 exit code，只适合作为模型交互参考。
8. 不把完整 bash 输出的本地 temp path 默认暴露给模型。它可能跨 cwd 且绕过文件审批边界；Susan 应让 continuation 经受控结果句柄或审批后的 `read` 完成。

## 实现票应固化的测试语义

- 每个 Tool 都要覆盖 relative/absolute/`..` 路径解析和 cwd 外审批分支；Pi 现有 suite 只验证动态 cwd，不验证 Susan 的 policy。
- `read` 覆盖 1-based offset、limit、line/byte 先到、首行超限、offset 越界、图片/非图片二进制。
- `write/edit` 覆盖创建/覆盖、父目录、原子失败不破坏旧文件、同路径并发序列化、abort race；`edit` 再覆盖缺失/重复/重叠/no-op/CRLF/BOM 和“任一失败则完全不写”。Pi 的同路径 queue 与 abort race 已有专门测试。来源：[`file-mutation-queue.test.ts#L37-L239`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/file-mutation-queue.test.ts#L37-L239)。
- `bash` 覆盖 success/nonzero/spawn error/timeout/abort、process-tree cleanup、UTF-8 chunk boundary、stdout/stderr 顺序、line/byte truncation。Pi 测试确认 timeout、截断错误仍保留 full output、流式 update 节流和 split UTF-8。来源：[`tools.test.ts#L485-L538`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/tools.test.ts#L485-L538)、[`tools.test.ts#L658-L760`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/tools.test.ts#L658-L760)。
- `grep/find` 覆盖 flag-like pattern 不成为 CLI option、gitignore/hidden、path glob、Windows separator、limit 与 byte truncation；`ls` 覆盖 dotfiles、目录后缀、稳定排序、不可 stat entry 和空目录。Pi 已有 flag-injection 与 gitignore/path-glob regression tests。来源：[`tools.test.ts#L782-L899`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/tools.test.ts#L782-L899)、[`3302-find-path-glob.test.ts#L19-L73`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts#L19-L73)、[`3303-find-nested-gitignore.test.ts#L17-L79`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/test/suite/regressions/3303-find-nested-gitignore.test.ts#L17-L79)。

## 结论

Pi 最值得 Susan 采用的是七个清晰的模型入口、按 invocation cwd 解析、批量且预验证的 edit、针对用途选择 head/tail 的统一输出预算，以及取消/并发的测试思路。最不应照搬的是“cwd 等于安全边界”的隐含误读、`rg/fd` 自动下载、fuzzy edit、直接覆盖写、Pi-specific session/TUI hooks，以及 bash 合并输出且缺少结构化 exit code 的结果形态。
