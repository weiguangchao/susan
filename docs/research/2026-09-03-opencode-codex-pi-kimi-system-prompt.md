# 主流 CLI agent 的系统提示词策略：OpenCode / Codex / Pi / Kimi Code

## 范围与证据

本文回答 [决策：系统提示词与配置边界（0.0.1）](https://github.com/weiguangchao/susan/issues/21) 的前置调研问题：四个 CLI agent 的默认 system prompt 放在哪里、包含什么运行时上下文、是否允许用户或 extension 覆盖，以及 `/clear`、resume、Compaction 时如何处理。

只使用官方仓库源码和仓库内官方文档，不使用二手文章。固定快照如下（均于 2026-09-03 检出）：

- OpenCode：[`anomalyco/opencode@b578b7261fc9ec4917fe272df5cc4bd8a056cd5d`](https://github.com/anomalyco/opencode/tree/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d)
- Codex：[`openai/codex@8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f`](https://github.com/openai/codex/tree/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f)
- Pi：[`earendil-works/pi@4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057`](https://github.com/earendil-works/pi/tree/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057)
- Kimi Code CLI：[`MoonshotAI/kimi-code@ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3`](https://github.com/MoonshotAI/kimi-code/tree/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3)

下文均为上述快照可直接验证的行为。四个项目都在快速演进；本文不推断未公开的服务端 prompt。

## 结论速览

| 维度 | OpenCode | Codex | Pi | Kimi Code |
| --- | --- | --- | --- | --- |
| 默认 prompt 归属 | 源码内置多份 `.txt`，按 provider/model 家族选择 | model metadata 的 `instructions_template`，按模型与 personality 渲染 | 源码模板 `buildSystemPrompt()` | 默认 profile 的 `system.md` |
| 运行时注入 | cwd、worktree、git repo、platform、date、references、skills、MCP instructions、AGENTS/instructions | base instructions + developer instructions + permissions/apps/skills/environment 等 contextual fragments | cwd、available tools、guidelines、pi docs、AGENTS.md、skills | cwd 等模板变量、AGENTS.md、plugin sections |
| 用户覆盖 | custom agent 可整体替换 base prompt；AGENTS/instructions 是追加而非替换 | `instructions` / `model_instructions_file` / `developer_instructions` 覆盖或补充 | `--system-prompt` 整体替换，`--append-system-prompt` 追加 | `~/.kimi-code/SYSTEM.md` 或 agent file 整体替换；可用 `${base_prompt}` 包装默认 |
| session 内修改 | plugin transform / extension hook 可变请求 prompt | turn settings / extension 可注入 developer instructions；session 内模式变化有专门 instructions | extension 可每 turn 返回 prompt override；工具集变化会重建 base prompt | plugin reload 会刷新 live agent prompt；resume 起初用 persisted prompt，可显式 refresh |
| resume 语义 | 每次 LLM 请求重新拼 prompt；system 不作为对话历史保存 | base instructions 可从 thread history 继承，自定义来源标记 provenance | 一般重建当前 base prompt；挂起 run 的 override 存入 operation record | resumed agent 先保留 persisted prompt，`refreshSystemPrompt()` 读取当前磁盘 |
| compaction | 普通 prompt 属于每次请求组装，不混入 compaction summary | compaction 请求继续使用当前 base instructions；replacement history 保留其状态 | compaction 使用独立 summarization system prompt | compaction 请求继续使用当前 agent system prompt 并计入估算 |

共同点是：**没有一个项目把 system prompt 当作普通聊天消息长期放在 Session Transcript 里；它是一个由 Harness 在请求前组装或继承的 privileged context。**差异在于：OpenCode/Pi/Codex 更强调从当前运行时重建；Kimi Code 会把已渲染 prompt 作为 agent 状态持久化，并为 resume 后的刷新提供显式机制。

## OpenCode

### 默认与覆盖

OpenCode 在源码里内置多份模型家族 prompt：`anthropic.txt`、`default.txt`、`beast.txt`、`gemini.txt`、`gpt.txt`、`kimi.txt`、`meta.txt`、`codex.txt` 等。`SystemPrompt.provider(model)` 根据 model id / provider id 选择其中一份。 [`system.ts#L18-L44`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/system.ts#L18-L44)

请求组装时，若当前 agent 自带 `agent.prompt`，则它取代 provider default；否则使用 provider default。然后继续拼接每次请求生成的 environment、instructions、MCP instructions、skills 等 system sections。 [`request.ts#L56-L64`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/llm/request.ts#L56-L64)

OpenCode 另有配置项 `instructions: string[]`，但文档定位是“additional instruction files or patterns”，与 `AGENTS.md` 一起合并为追加指令，不是替换内置 system prompt。 [`config.ts#L124-L126`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/core/src/v1/config/config.ts#L124-L126) [`rules.mdx#L130-L141`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/web/src/content/docs/rules.mdx#L130-L141)

### 动态内容

environment section 由 `SystemPrompt.Service.environment()` 生成，包含 model id、cwd、worktree、是否 git repo、platform、当前日期，以及 project references。 [`system.ts#L65-L104`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/system.ts#L65-L104)

Agent loop 在每次请求前并行取 skills、environment、instruction files、MCP instructions 和 model messages，再把这些 system sections 交给 LLM request preparation。 [`prompt.ts#L1248-L1266`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/prompt.ts#L1248-L1266)

还有一个 legacy `experimental.chat.system.transform` plugin hook，可在请求前变更 assembled system prompt；仓库自己的 domain note 也把它列为尚未由 V2 plugin API 取代的 escape hatch。 [`request.ts#L63-L70`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/llm/request.ts#L63-L70) [`CONTEXT.md#L220-L228`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/CONTEXT.md#L220-L228)

### resume 与 compaction

`prepared.system` 是每次 request preparation 的产物；它作为模型消息前的 system message 发送，而不是 Session 数据库中的普通 message record。 [`request.ts#L56-L69`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/llm/request.ts#L56-L69) [`request.ts#L93-L112`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/session/llm/request.ts#L93-L112)

因此 resume 后的请求会按当前 model、agent、environment 与 instruction 状态重新组装，而不是把旧 system prompt 当作历史消息重放。Compaction summary 是独立的 Session projection/checkpoint，不改变这个请求前组装模型。

## Codex

### 默认与覆盖

Codex 的 base instructions 属于模型 metadata：`ModelInfo.model_messages.instructions_template` 可带 personality placeholder，`get_model_instructions(personality)` 渲染后返回。 [`openai_models.rs#L392-L439`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/protocol/src/openai_models.rs#L392-L439) [`openai_models.rs#L518-L532`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/protocol/src/openai_models.rs#L518-L532)

Session 启动时的优先顺序是：config 里的 custom base instructions → thread history 继承的 base instructions → 当前 model 的默认 instructions。 [`session/mod.rs#L698-L706`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/session/mod.rs#L698-L706)

Config 支持三种来源：inline `base_instructions` / `instructions`、`model_instructions_file`，以及独立的 `developer_instructions`。前两者用于覆盖 base instructions；后者作为 developer fragment 附加。 [`config/mod.rs#L3899-L3914`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/config/mod.rs#L3899-L3914)

### 请求与继承

`get_prompt_base_instructions()` 渲染请求用 instructions，但注释明确说明“不改变 persisted 或 fork 继承的 instructions”；这层请求渲染只移除特定功能下的 update-plan 指令。 [`session/mod.rs#L1337-L1350`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/session/mod.rs#L1337-L1350)

Responses API 请求里，base instructions 可作为 top-level `instructions`；Responses Lite 路径则把它转成 prefix developer item。 [`client.rs#L942-L970`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/client.rs#L942-L970)

### resume 与 compaction

自定义 base instructions 的 provenance 会记录为 custom；从 history 继承时也会尝试识别其来源。 [`session/session.rs#L681-L697`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/session/session.rs#L681-L697)

local compaction 的 summarizer 请求构造 `Prompt` 时显式携带 `base_instructions: sess.get_prompt_base_instructions()`。 [`compact.rs#L278-L285`](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/core/src/compact.rs#L278-L285) 这意味着 compaction 不是把 system prompt 总结掉，而是继续把当前 canonical base instructions 放在请求前。

## Pi

### 默认与覆盖

Pi 的默认 prompt 由源码函数 `buildSystemPrompt()` 生成，开头明确声明“expert coding assistant operating inside pi”。模板包含 available tools、guidelines、Pi 文档路径、AGENTS.md project context、skills 和 cwd。 [`system-prompt.ts#L11-L28`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/system-prompt.ts#L11-L28) [`system-prompt.ts#L129-L182`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/system-prompt.ts#L129-L182)

`BuildSystemPromptOptions` 分开表达 `customPrompt`（替换默认）与 `appendSystemPrompt`（追加）。即使提供 `customPrompt`，Pi 仍会追加 project context、可用 skills 与 cwd；这保证运行时环境不被整体替换掉。 [`system-prompt.ts#L11-L26`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/system-prompt.ts#L11-L26) [`system-prompt.ts#L30-L56`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/system-prompt.ts#L30-L56)

CLI 提供两个入口：`--system-prompt` 替换默认 coding assistant prompt，`--append-system-prompt` 追加 text 或 file contents，可重复使用。 [`args.ts#L107-L115`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/cli/args.ts#L107-L115) [`args.ts#L278-L284`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/cli/args.ts#L278-L284)

### 请求内刷新

`AgentSession` 保存 `_baseSystemPrompt` 与 `_systemPromptOverride`；工具集变化时重建 base prompt，extension 返回 override 时下一次请求使用 override，run 结束后清除。 [`agent-session.ts#L378-L388`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/agent-session.ts#L378-L388) [`agent-session.ts#L975-L994`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/agent-session.ts#L975-L994) [`agent-session.ts#L1290-L1308`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/agent-session.ts#L1290-L1308)

因此 `/clear` 或新 run 不继承上一次 per-run override；AGENTS.md / skills / tools 的变化可在下一次 base prompt rebuild 时生效。

### resume 与 compaction

Pi 的 JSONL session 存 operation records；只有 suspended run 的 `operation_started.intent` 里有 `systemPromptOverride`，用于恢复该 run 的显式 override。 [`types.ts#L84-L107`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/agent/src/harness/session/types.ts#L84-L107) 普通 base system prompt 不作为对话 transcript 持久化，而是由当前资源与工具状态重建。

Compaction/branch summarization 请求使用独立的 `SUMMARIZATION_SYSTEM_PROMPT`，而不是直接复用 coding-agent 的默认 prompt。 [`branch-summarization.ts#L340-L352`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/compaction/branch-summarization.ts#L340-L352) [`compaction.ts#L636-L648`](https://github.com/earendil-works/pi/blob/4e69b0c28060f0f02fbe38bfa7c21a2e2eb25057/packages/coding-agent/src/core/compaction/compaction.ts#L636-L648)

## Kimi Code

### 默认与覆盖

默认 agent profile 指向 `./system.md`，并声明全部内置工具。 [`agent.yaml#L1-L30`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/src/profile/default/agent.yaml#L1-L30)

默认 prompt 内容很长，先定义“Kimi Code CLI, interactive general AI agent”，再规定语言跟随用户、工具调用、代码工程、验证、上下文压缩等行为。 [`system.md#L1-L74`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/src/profile/default/system.md#L1-L74)

用户全局覆盖方式是 `~/.kimi-code/SYSTEM.md`：文件存在且非空时，整体替换默认 main agent 的 system prompt，但保留默认 profile 的 description、tools 与 sub-agent 配置。 [`agents.md#L140-L157`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/docs/en/customization/agents.md#L140-L157)

agent file / `SYSTEM.md` 是模板，支持 `${base_prompt}`、`${plugin_sections}`、cwd 等变量；可以用 `${base_prompt}` 包装默认行为，而不是只能替换。 [`agents.md#L100-L113`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/docs/en/customization/agents.md#L100-L113)

### plugin 与 live session

plugin 可通过 `systemPrompt` / `systemPromptPath` 贡献系统提示词；安装或 reload 后才读取，live agent 需要 `/plugins reload` 触发 `refreshSystemPrompt()`。 [`plugins.md#L278-L306`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/docs/en/customization/plugins.md#L278-L306) [`session/index.ts#L1243-L1259`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/src/session/index.ts#L1243-L1259)

### resume 与 compaction

Kimi 的测试明确覆盖 “resumed native session system prompt”：resume 后 agent 最初包含旧 `AGENTS.md` 内容；调用 `refreshSystemPrompt()` 后才替换为磁盘上的新内容。 [`init.test.ts#L199-L240`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/test/session/init.test.ts#L199-L240) 换言之，它默认保留 persisted prompt，而不像 OpenCode/Pi 那样每次无条件重建。

full compaction 的 token 估算把 `agent.config.systemPrompt`、tools 与 messages 都计入；summarizer 调用也显式传入当前 `agent.config.systemPrompt`。 [`full.ts#L233-L245`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/src/agent/compaction/full.ts#L233-L245) [`full.ts#L473-L487`](https://github.com/MoonshotAI/kimi-code/blob/ff7ed1cc86da454c72e74ebdafabaec9dd4b6cc3/packages/agent-core/src/agent/compaction/full.ts#L473-L487)

## 对 susan 0.0.1 的启示

1. **默认 prompt 应是源码常量或模板，而不是 Config 字段。**四家默认都由产品分发；用户覆盖是额外能力。susan 0.0.1 的 Config schema 已定稿且没有 prompt 字段，硬编码最小默认 prompt 是一致选择。
2. **cwd 应作为运行时注入，而不是 prompt 文本本身。**OpenCode、Pi、Kimi 都注入 live cwd；susan 的 read_file 语义也依赖 cwd，必须在请求前注入当前值。
3. **Prompt 不应写进 Session Transcript。**四家都不是把 system prompt 当普通消息保存；OpenCode/Pi 基本每次重建，Codex/Kimi 有显式继承机制。susan 0.0.1 无 prompt 覆盖能力，选择“每次由当前源码重建”最简单，也能让升级后的新 prompt 立即生效。
4. **Compaction 不应总结 system prompt。**Codex 与 Kimi 在 compaction 请求中继续使用当前 system prompt；Pi 使用独立 summarizer prompt。susan 已定“canonical system prompt 由 Harness 重新注入”，应保持该结论。
5. **若未来允许覆盖，需区分 replace 与 append。**Pi 的 `--system-prompt` / `--append-system-prompt` 和 Kimi 的 `${base_prompt}` 包装语义比单一 `systemPrompt` 字段清晰；但 0.0.1 不应引入这层复杂度。
