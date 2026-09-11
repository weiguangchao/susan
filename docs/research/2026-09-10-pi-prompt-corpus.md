# Pi 提示词全集与 Susan 迁移面快照

> 日期：2026-09-10  
> 范围：在 Pi 主线 commit [`400d690`](https://github.com/earendil-works/pi/tree/400d6905ce46ec46e79da8a7701b1b48850192df) 锚点下，完整提取 (1) system prompt 拼装机制、(2) 七个内置 Tool 的全部提示词文案、(3) compaction 提示词三件套，并对照 Susan 当前代码列出迁移面；只陈述事实与对照，不替后续决策票做选择。  
> 证据来源：Pi 仓库 `earendil-works/pi`（原 `badlogic/pi-mono`，301 重定向）main 分支 `400d690`；Susan 本地仓库 `weiguangchau/susan` 工作区当前 HEAD。Pi 侧引用一律给出 `file:line`（行号即该 commit 下源码行号）。

## 结论先行

1. **Pi 的 system prompt 是"拼装"而非"常量"**：`buildSystemPrompt()` 接收 toolSnippets/promptGuidelines/contextFiles/skills 等 8 个输入，按"身份段 → Available tools → Guidelines → Pi documentation → append → project_context → skills → cwd"的固定顺序拼装；Susan 的 `CANONICAL_SYSTEM_PROMPT` 是单一字符串常量，只有一个 `{cwd}` 占位符。迁移面是结构性差异，不只是文案替换。
2. **七个 Tool 的提示词分两层**：description（发给模型的 tool 定义）与 promptSnippet/promptGuidelines（进 system prompt 的一行简介与 guideline 条目），两者在 Pi 里由导出的 `*ToolSystemPromptContribution` 常量做单一事实来源，并有专门的表驱动测试锁对齐。Susan 目前只有 description 一层。
3. **Compaction 三件套齐全拿到全文**：`SUMMARIZATION_PROMPT` / `UPDATE_SUMMARIZATION_PROMPT`（内嵌 `UPDATE_SUMMARIZATION_INSTRUCTIONS`）/ `getSummarizationFailure` 都在 `compaction.ts`；`SUMMARIZATION_SYSTEM_PROMPT` 不在 compaction.ts 而在 `compaction/utils.ts`。Susan 对应物只有一段 `COMPACTION_SUMMARY_PROMPT`（update 型），且摘要请求复用了完整的产品 system prompt，而 Pi 用专用的摘要器 system prompt。
4. **Pi 特有需删除的内容清单**（详见末节）：Pi documentation 段、`PI_*` 环境变量 guideline、PowerShell 分支、"other custom tools" 提示、skills/contextFiles/customPrompt 通道。Susan 均无对应物。

---

## 一、Pi System Prompt 拼装机制

### 1.1 `buildSystemPrompt()` 全文逻辑

文件：`packages/coding-agent/src/core/system-prompt.ts`（168 行，全文通读）。

**入参**（system-prompt.ts:8-25）：`customPrompt`（整体替换默认 prompt）、`selectedTools`（默认 `["read", "bash", "edit", "write"]`，system-prompt.ts:45）、`toolSnippets`（工具名 → 一行简介）、`promptGuidelines`（附加 guideline 条目）、`appendSystemPrompt`（追加文本）、`cwd`、`contextFiles`、`skills`。

**customPrompt 分支**（system-prompt.ts:48-73）：一旦提供 `customPrompt`，默认身份段/工具表/Guidelines 全部不出现，输出为 `customPrompt + appendSection + <project_context> 块 + skills 块 + cwd 行`。project_context 块格式（system-prompt.ts:56-63）：

```
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="${filePath}">
{content}
</project_instructions>

</project_context>
```

skills 块仅当工具集里有 `read` 或 `bash` 时才注入（`skillFileReadTool`，system-prompt.ts:46、66-68），由 `formatSkillsForPrompt()`（`core/skills.ts`，本次未展开）生成。

**默认分支的段落结构**（按出现顺序）：

1. **身份段**（system-prompt.ts:127）：`You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`
2. **Available tools**（system-prompt.ts:129-132）：只有提供了 snippet 的工具才可见（`visibleTools = tools.filter((name) => !!toolSnippets?.[name])`，system-prompt.ts:82），格式 `- ${name}: ${snippet}`，无 snippet 时为 `(none)`；随后一句 `In addition to the tools above, you may have access to other custom tools depending on the project.`（system-prompt.ts:132）。
3. **Guidelines**（system-prompt.ts:134-135）：见 1.2 的组装规则。
4. **Pi documentation**（system-prompt.ts:137-144）：指向 pi 自身的 readme/docs/examples 路径与主题路由规则（Pi 特有，Susan 无对应物）。
5. **appendSystemPrompt**（system-prompt.ts:146-148）：`\n\n${appendSystemPrompt}`。
6. **project_context**（system-prompt.ts:151-158）：同 customPrompt 分支格式。
7. **skills**（system-prompt.ts:160-163）：同 customPrompt 分支条件。
8. **cwd 尾行**（system-prompt.ts:165）：`Current working directory: ${promptCwd}`（反斜杠已归一为 `/`，system-prompt.ts:39）。

### 1.2 Guidelines 组装与条件裁剪

（system-prompt.ts:86-125）

- **去重**：`addGuideline` 用 Set 保证顺序稳定且不重复（system-prompt.ts:87-95）。
- **条件裁剪规则**（system-prompt.ts:97-112）：当有 `bash`（或 `powershell`）且**没有** `grep`、`find`、`ls` 时，加一条替代 guideline：
  - bash+powershell：`Use bash or PowerShell for file operations like listing, searching, and finding files`
  - 仅 powershell：`Use PowerShell for file operations like listing, searching, and finding files`
  - 仅 bash：`Use bash for file operations like ls, rg, find`
- **工具注入的 guidelines**（system-prompt.ts:114-119）：来自各 Tool 的 `promptGuidelines`，trim 后逐条加入（见 1.3）。
- **固定两条**（system-prompt.ts:122-123）：`Be concise in your responses`、`Show file paths clearly when working with files`。

### 1.3 agent-session.ts 的 snippet / guidelines 收集与注入

文件：`packages/coding-agent/src/core/agent-session.ts`（3550 行）。

- **存储**：`_toolPromptSnippets: Map<string, string>` 与 `_toolPromptGuidelines: Map<string, string[]>`（agent-session.ts:372-373）。
- **归一化**：`_normalizePromptSnippet` 把多行文本压成单行（agent-session.ts:1037-1044）；`_normalizePromptGuidelines` trim + 去重（agent-session.ts:1046-1059）。
- **收集时机**：`_refreshToolRegistry()` 合并内置工具、extension 工具、SDK 自定义工具后，从每个 `ToolDefinition` 的 `promptSnippet` / `promptGuidelines` 建两张 Map（agent-session.ts:2726-2741）。
- **注入时机**：`_rebuildSystemPrompt(toolNames)`（agent-session.ts:1061-1095）按激活工具顺序收集 snippet 与 guidelines，连同 resource loader 提供的 `customPrompt`（loader system prompt）、`appendSystemPrompt`、skills、agentsFiles（contextFiles）一起调用 `buildSystemPrompt`（agent-session.ts:1084-1094）。
- **重建触发点**：`setActiveToolsByName()`（agent-session.ts:966-981，在 979 重建）与 `extendResourcesFromExtensions()`（agent-session.ts:2491-2514，在 2512 重建）。

### 1.4 bash 的条件 guideline

bash 的 `promptGuidelines` 只有在 `exposeSessionEnvironment` 为 true（默认）时才注入（bash.ts:229、236）；关闭后 definition 的 `promptGuidelines` 为 `undefined`（见 bash.ts:236 与测试 test/tool-system-prompt-contributions.test.ts:36-43）。

### 1.5 测试的断言方式（对 Susan 的参考价值）

`packages/coding-agent/test/tool-system-prompt-contributions.test.ts`（44 行）：

- 表驱动：每个工具一个 `[name, contribution, createDefinition]` 三元组（test/tool-system-prompt-contributions.test.ts:14-23）。
- 断言 `definition.promptSnippet === contribution.snippet` 且 `definition.promptGuidelines ?? []` 深等于 `contribution.guidelines`（test/tool-system-prompt-contributions.test.ts:26-34）——即"单一事实来源常量 ↔ 工具定义"锁对齐，不测拼装后的完整 prompt。
- 另一条断言 bash/powershell 在 `exposeSessionEnvironment: false` 时 `promptGuidelines` 为 `undefined`（test/tool-system-prompt-contributions.test.ts:36-43）。

---

## 二、七个 Tool 的提示词全文

通用背景：截断常量来自 `packages/coding-agent/src/core/tools/truncate.ts`：`DEFAULT_MAX_LINES = 2000`（truncate.ts:11）、`DEFAULT_MAX_BYTES = 50 * 1024`（truncate.ts:12）、`GREP_MAX_LINE_LENGTH = 500`（truncate.ts:13）。以下 description 中出现的 2000/50KB/500 均为这些常量插值。

### 2.1 read

文件：`packages/coding-agent/src/core/tools/read.ts`。

- **description**（read.ts:73）：

  > Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.

- **promptSnippet**（read.ts:20-23）：`Read file contents`
- **promptGuidelines**（read.ts:20-23）：`Use read to examine files instead of cat or sed.`
- **参数 schema**（read.ts:14-18）：
  - `path`：`Path to the file to read (relative or absolute)`
  - `offset`：`Line number to start reading from (1-indexed)`
  - `limit`：`Maximum number of lines to read`

### 2.2 write

文件：`packages/coding-agent/src/core/tools/write.ts`。

- **description**（write.ts:52-53）：

  > Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

- **promptSnippet**（write.ts:16-19）：`Create or overwrite files`
- **promptGuidelines**（write.ts:16-19）：`Use write only for new files or complete rewrites.`
- **参数 schema**（write.ts:11-14）：
  - `path`：`Path to the file to write (relative or absolute)`
  - `content`：`Content to write to the file`

### 2.3 edit

文件：`packages/coding-agent/src/core/tools/edit.ts`。

- **description**（edit.ts:151-152）：

  > Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.

- **promptSnippet**（edit.ts:43-51）：`Make precise file edits with exact text replacement, including multiple disjoint edits in one call`
- **promptGuidelines**（edit.ts:43-51，4 条）：
  1. `Use edit for precise changes (edits[].oldText must match exactly)`
  2. `When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls`
  3. `Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.`
  4. `Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.`
- **参数 schema**（edit.ts:21-41）：
  - `path`：`Path to the file to edit (relative or absolute)`
  - `edits`（数组）：`One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.`
    - `oldText`：`Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.`
    - `newText`：`Replacement text for this targeted edit.`

### 2.4 bash

文件：`packages/coding-agent/src/core/tools/bash.ts`。

- **description**（bash.ts:234）：

  > Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

- **promptSnippet**（bash.ts:42-45）：`Execute bash commands (ls, grep, find, etc.)`
- **promptGuidelines**（bash.ts:42-45）：`You can inspect PI_* environment variables for current model and session details.`（条件注入，见 1.4）
- **参数 schema**（bash.ts:37-40）：
  - `command`：`Shell command to execute`
  - `timeout`：`Timeout in seconds (optional, no default timeout)`
- 说明：bash 通过 `createShellToolDefinition` + `bashToolConfig`（bash.ts:375-383）组装，PowerShell 复用同一 schema。

### 2.5 grep

文件：`packages/coding-agent/src/core/tools/grep.ts`。

- **description**（grep.ts:78）：

  > Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.

- **promptSnippet**（grep.ts:35-38）：`Search file contents for patterns (respects .gitignore)`
- **promptGuidelines**（grep.ts:35-38）：`[]`（空；definition 上甚至没有 `promptGuidelines` 字段）
- **参数 schema**（grep.ts:21-33）：
  - `pattern`：`Search pattern (regex or literal string)`
  - `path`：`Directory or file to search (default: current directory)`
  - `glob`：`Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'`
  - `ignoreCase`：`Case-insensitive search (default: false)`
  - `literal`：`Treat pattern as literal string instead of regex (default: false)`
  - `context`：`Number of lines to show before and after each match (default: 0)`
  - `limit`：`Maximum number of matches to return (default: 100)`

### 2.6 find

文件：`packages/coding-agent/src/core/tools/find.ts`。

- **description**（find.ts:78）：

  > Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).

- **promptSnippet**（find.ts:34-37）：`Find files by glob pattern (respects .gitignore)`
- **promptGuidelines**（find.ts:34-37）：`[]`（空，同 grep）
- **参数 schema**（find.ts:26-32）：
  - `pattern`：`Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'`
  - `path`：`Directory to search in (default: current directory)`
  - `limit`：`Maximum number of results (default: 1000)`

### 2.7 ls

文件：`packages/coding-agent/src/core/tools/ls.ts`。

- **description**（ls.ts:62）：

  > List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).

- **promptSnippet**（ls.ts:16-19）：`List directory contents`
- **promptGuidelines**（ls.ts:16-19）：`[]`（空，同 grep）
- **参数 schema**（ls.ts:11-14）：
  - `path`：`Directory to list (default: current directory)`
  - `limit`：`Maximum number of entries to return (default: 500)`

---

## 三、Compaction 提示词三件套全文

文件：`packages/coding-agent/src/core/compaction/compaction.ts`（1012 行）与 `packages/coding-agent/src/core/compaction/utils.ts`（158 行）。

### 3.1 SUMMARIZATION_PROMPT（compaction.ts:467-498，全文）

```
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

### 3.2 UPDATE_SUMMARIZATION_INSTRUCTIONS（compaction.ts:500-535，全文）

```
Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
```

### 3.3 UPDATE_SUMMARIZATION_PROMPT（compaction.ts:537-539，全文）

```
The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

（此处内嵌 3.2 的 UPDATE_SUMMARIZATION_INSTRUCTIONS 全文，模板字符串插值）
```

### 3.4 getSummarizationFailure（compaction.ts:545-553，全文）

```ts
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}
```

### 3.5 SUMMARIZATION_SYSTEM_PROMPT（定义位置与内容）

**定义位置**：不在 compaction.ts，而在 `compaction/utils.ts:156-158`，由 compaction.ts:19-27 的 import 引入，在 `buildSummarizationContext()`（compaction.ts:642-653）作为摘要请求的 systemPrompt 使用（compaction.ts:644）。全文：

```
You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.
```

### 3.6 使用机制（拼装顺序与防护）

- **prompt 拼装**（compaction.ts:678-693）：`<conversation>\n{serializeConversation(llmMessages)}\n</conversation>` + （有前次摘要时）`<previous-summary>\n{previousSummary}\n</previous-summary>` + basePrompt（首 次 用 SUMMARIZATION_PROMPT，有前次用 UPDATE_SUMMARIZATION_PROMPT）；`customInstructions` 以 `\n\nAdditional focus: ${customInstructions}` 追加（compaction.ts:679-681）。
- **maxTokens**：`min(floor(0.8 * reserveTokens), model.maxTokens)`（compaction.ts:672-675）；turn prefix 摘要用 0.5 系数（compaction.ts:983-986）。
- **防护**：`getSummarizationFailure` 的 error/length stopReason 拒绝（compaction.ts:715-718）；摘要响应含 toolCall 直接报错（compaction.ts:719-721）；摘要经 `retryAssistantCall` 包装可重试（compaction.ts:579-599）。
- **文件操作追踪**：摘要末尾追加 `<read-files>` / `<modified-files>` XML 块（compaction.ts:949-951，格式见 utils.ts:72-82），来源是从 tool call 解析的 read/write/edit 操作（utils.ts:29-56）。
- **序列化**：`serializeConversation` 把对话压成 `[User]: / [Assistant]: / [Assistant thinking]: / [Assistant tool calls]: / [Tool result]:` 行式文本，tool result 截断到 2000 字符（utils.ts:89、109-150）。
- **附带发现**：还有第四个提示词 `TURN_PREFIX_SUMMARIZATION_PROMPT`（compaction.ts:835-848，split-turn 时对被裁掉的 turn 前缀单独摘要），Susan 无对应物。

---

## 四、Susan 对应物对照表

| Pi 侧（@400d690） | Susan 侧（当前 HEAD） | 差异要点 |
|---|---|---|
| `buildSystemPrompt(options)` 拼装（system-prompt.ts:28-168） | `CANONICAL_SYSTEM_PROMPT` 常量 + `buildSystemPrompt(cwd)`（src/core/harness.ts:35-52） | Pi 拼装 8 段；Susan 单常量、仅 `{cwd}` 替换（用 replacer 函数防 `$` 注入，harness.ts:51） |
| 身份段 "expert coding assistant … inside pi"（system-prompt.ts:127） | "You are Susan, a terminal coding agent operating inside a minimal personal Harness."（harness.ts:35） | 皆为首行身份声明 |
| Available tools 列表由 snippet 生成（system-prompt.ts:80-84） | 无工具列表；工具指引在 Operating rules 第 3 条（harness.ts:42） | Susan 用一段 bullet 覆盖 7 工具分工 |
| 工具 guidelines 注入 system prompt（agent-session.ts:1061-1095） | 无对应物 | Susan 无 snippet/guidelines 层 |
| 条件裁剪 guideline（system-prompt.ts:104-112） | 无对应物（7 工具恒全开） | bash-only 场景在 Susan 不存在 |
| read description（read.ts:73） | `READ_DESCRIPTION`（src/core/read.ts:21-22），schema 在 read.ts:440-461 | Pi 含图片支持与 2000 行/50KB 数字；Susan 含 nextArguments 指引、100 MiB 上限 |
| write description（write.ts:52-53） | `WRITE_DESCRIPTION`（src/core/write.ts:30-31），schema 在 write.ts:298-312 | Susan 更长：拒绝 symlink、created/overwritten 上报 |
| edit description + 4 guidelines（edit.ts:43-51、151-152） | `EDIT_DESCRIPTION`（src/core/edit.ts:36-37），schema 在 edit.ts:853-892 | Susan 有 `replaceAll` 参数与 ENONUNIQUE 语义；Pi 无 replaceAll |
| bash description + PI_* guideline（bash.ts:42-45、234） | `BASH_DESCRIPTION`（src/core/bash.ts:30-31），schema 在 bash.ts:1013-1040 | Pi timeout 秒 / Susan timeoutMs 毫秒；Pi 无 cwd/env 参数、Susan 有 |
| grep description（grep.ts:78） | `GREP_DESCRIPTION`（src/core/grep.ts:39-40），schema 在 grep.ts:834-895 | Susan 多 maxDepth/includeIgnored/offset；Pi 有 ripgrep 后端 |
| find description（find.ts:78） | `FIND_DESCRIPTION`（src/core/find.ts:30-31），schema 在 find.ts:495-539 | Susan 多 type/maxDepth/includeIgnored/offset |
| ls description（ls.ts:62） | `LS_DESCRIPTION`（src/core/ls.ts:28-29），schema 在 ls.ts:435-462 | Susan 多 includeIgnored/offset；Pi 含 dotfiles 说明 |
| SUMMARIZATION_PROMPT（compaction.ts:467-498） | 无对应物（Susan 只有 update 型） | Susan 的 `COMPACTION_SUMMARY_PROMPT`（src/core/context.ts:12-14）只覆盖 update 语义 |
| UPDATE_SUMMARIZATION_PROMPT / INSTRUCTIONS（compaction.ts:500-539） | `COMPACTION_SUMMARY_PROMPT`（src/core/context.ts:12-14）+ `serializeCompactionInput`（context.ts:144-180） | Susan 头部一段 update 指令 + `Previous summary:` + `Newly compacted transcript:`；Pi 用 XML 标签包裹且格式模板精确到每个小节 |
| SUMMARIZATION_SYSTEM_PROMPT（utils.ts:156-158，专用摘要器身份） | 无对应物；摘要请求 system 消息用完整产品 `buildSystemPrompt(cwd)`（src/core/harness.ts:596-598） | Pi 明确"Do NOT continue the conversation"；Susan 让摘要请求携带全部 Operating rules |
| getSummarizationFailure（compaction.ts:545-553） | 近似物：finishReason !== "stop" / toolCalls / 空 content 三重检查（src/core/harness.ts:669-683） | 语义相近（拒绝 length 截断的摘要），实现形态不同 |
| `<previous-summary>` / `<conversation>` 包裹（compaction.ts:689-693） | `MODEL_CONTEXT_SUMMARY_PREFIX = "Session summary:\n"` 注入回放（src/core/context.ts:16、67-81） | Pi 回放摘要的包装格式未在本次范围内取证 |
| `<read-files>`/`<modified-files>` 追加（compaction.ts:949-951） | 无对应物 | Susan 不追踪文件操作 |

**buildSystemPrompt 的 Susan 调用点**（均在 src/core/harness.ts）：`contextTooLarge()` 497-499、`estimateCurrentContext()` 535、`compactContext()` tailTarget 计算 574、摘要请求 system 消息 597、tokensAfterEstimate 694、`requestProvider()` 请求 system 消息 744。

**受影响测试清单**：

- `test/coding-agent-prompt.test.ts`：EXPECTED_SYSTEM_PROMPT 全文精确比对（:4-17、21）、负面断言（无 read_file / 审批措辞 / 数字，:26-33）、cwd 替换（:36-56）。任何 system prompt 文案改动都会打爆此文件。
- `test/built-in-tools.test.ts`：CANONICAL_DESCRIPTIONS 七工具全文精确比对（:4-13、33-37）。
- `test/context-compaction.test.ts`：摘要请求 shape 断言含 `buildSystemPrompt("/workspace")` 作 system（:155-166）、滚动摘要不重复摘要旧 transcript（:393-396）。
- `test/harness.test.ts`：请求 system 消息用 `buildSystemPrompt` 断言（:219、:268、:334）。
- 各 tool 测试（read/write/edit/bash/grep/find/ls.test.ts）：**不**断言 description 文案，仅行为测试——description 迁移不波及它们。
- 参考：Pi 的对齐测试模式（tool-system-prompt-contributions.test.ts:26-34）可为 Susan 新增 snippet/guidelines 层时复用。

---

## 五、迁移注意点：Pi 特有需删除/无对应物清单

1. **Pi documentation 段**（system-prompt.ts:137-144）：readme/docs/examples 路径与"何时读哪个 .md"的主题路由，全部指向 pi 自身文档，Susan 一行不留。
2. **`PI_*` 环境变量 guideline**（bash.ts:44）：Susan 无 PI_SESSION_ID/PI_MODEL 等注入。
3. **"other custom tools" 提示句**（system-prompt.ts:132）：Susan 工具集固定为 7 个，无 extension/SDK 注册通道。
4. **PowerShell 分支**（system-prompt.ts:98、105-108；bash.ts:79-155 复用）：Susan 只支持 bash。
5. **customPrompt / appendSystemPrompt / contextFiles(agentsFiles) / skills 通道**（system-prompt.ts:8-25）：Susan 均无；system prompt 是静态常量。
6. **snippet 的条件可见性**（无 snippet 即从 Available tools 隐藏，system-prompt.ts:82）与 **bash-only 裁剪 guideline**（system-prompt.ts:104-112）：Susan 恒全开 7 工具，规则不适用。
7. **数字内嵌**：Pi 把 2000 行 / 50KB / 500 chars 写进 description（read.ts:73、bash.ts:234、grep.ts:78 等，值来自 truncate.ts:11-13）；Susan 的 system prompt 测试明确禁止出现数字（test/coding-agent-prompt.test.ts:32-34），但 tool description 目前含数字（如 read.ts:457 "defaults to 2000"）——迁移时两条规范不一致，需在决策票中定夺。
8. **read 的图片支持**（read.ts:73）：Susan 的 read 不支持图片，该句不能照搬。
9. **bash 的"full output saved to a temp file"**（bash.ts:234）：Susan 的 bash 无 temp file 回放机制。
10. **Compaction 的 first-time prompt**：Susan 只有 update 型提示词，若要完整迁移三件套需要新增首次摘要提示词；同时注意 Pi 摘要请求的 system 是专用短提示词而非产品 system prompt（compaction.ts:644 vs harness.ts:597），这是 #93 的核心决策点之一。

## 六、值得地图注意的意外事实

- **Pi 的 compaction 还有第四个提示词** `TURN_PREFIX_SUMMARIZATION_PROMPT`（compaction.ts:835-848），用于 turn 被从中间裁开时对前缀单独摘要；Susan 的 `selectRecentTailStart` 保证只在完整 turn 边界裁（src/core/context.ts:103-142），结构上规避了该需求——迁移时**不应**引入它，但票 #93 讨论范围应显式排除。
- **Pi 摘要请求会追加文件清单**（`<read-files>`/`<modified-files>`，compaction.ts:949-951），Susan 完全没有文件操作追踪这一层。
- **Pi 的 tool prompt 两层结构（description + snippet/guidelines）由表驱动测试锁定**（test/tool-system-prompt-contributions.test.ts），这是"文案单一事实来源 + 测试对齐"的可复用模式；Susan 现有的 CANONICAL_DESCRIPTIONS 全文比对（test/built-in-tools.test.ts:4-13）等价但维护成本更高（两处全文复制）。
- **grep/find/ls 在 Pi 的 guidelines 为空数组**，guidance 全部集中在 description 与 system prompt 的 bash-only 裁剪规则里；真正带 guidelines 的只有 read/write/edit/bash 四个。
- **Pi 的固定 guidelines 只有两句**（"Be concise" / "Show file paths clearly"，system-prompt.ts:122-123），而 Susan 的 Operating rules 有 9 条且语义密度高得多——迁移不是往 Pi 模板里塞 Susan 规则，而是决定哪些规则留在 system prompt、哪些下沉到 tool 层。
