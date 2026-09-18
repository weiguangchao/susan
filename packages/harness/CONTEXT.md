# Harness

围绕 LLM 的运行外壳：把用户消息、Tool 调用、Tool Result、Approval Policy、上下文管理串成一个循环。TUI 是它当前的客户端，不是它本身。

## Language

**Coding Agent**:
在 Harness 内与用户交互、使用 Tool 完成 coding 任务的模型角色；Susan 的 System Prompt 定义其身份与跨 Tool 行为边界。
_Avoid_: harness agent, model runtime

**Harness Assembly**:
Harness 内无 UI 的装配对象，持有本次运行的 Susan Home、已加载的 Config 与当前 Harness，负责启动和切换 Session。它返回可分支的结果；外部 Config 修改经显式重新加载才生效，Session 切换沿用当前配置。
_Avoid_: bootstrap, launcher, 一键启动

**Provider Type**:
Config entry 中的 wire protocol 标识。0.0.1 只注册 `openai-completion`，其他合法但未注册的值 fail-fast。
_Avoid_: provider alias, backend name

**Model Catalog**:
单个 provider entry 中可选静态声明的模型集合；省略时该 provider 不可被应用，根节点 `defaultModel` 也不能激活它。模型默认参数在代码中定义，需要定制时由具体模型条目覆盖 context window 与最大输出 tokens，Reasoning Effort 由代码中的 Provider Type 常量提供。
_Avoid_: model registry, model discovery result

**Agent Loop**:
Harness 的核心循环：一次用户输入触发的「模型输出 → Tool 调用 → Tool 结果回填 → 再次模型输出」直到模型不再请求 Tool。
_Avoid_: turn loop, chat loop

**Tool Round**:
Agent Loop 中从模型发出一个 Tool Batch，到该批全部 Tool Result 回填完成的一轮。
_Avoid_: iteration, step

**Tool Batch**:
模型在同一条 assistant 输出中请求的一组 Tool Call；单个 Tool Call 也构成一个 Tool Batch。
_Avoid_: parallel tools, tool group

**Tool**:
Harness 暴露给模型、可由模型请求调用的一项能力。
_Avoid_: function, plugin, skill

**Built-in Tool Set**:
Susan 面向本地 coding agent 场景提供的七个模型侧 Tool：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`；功能与表示层对齐 Pi，Approval Policy 仍为 Yolo。
_Avoid_: tool pack, Pi-compatible tools

**Read Tool**:
Built-in Tool Set 中按路径分页读取文本或读取图片附件的 Tool；模型侧名称为 `read`，不保留 `read_file` alias。
_Avoid_: Read File Tool, file reader, cat tool

**Image Content**:
Tool Result 中供支持视觉输入的模型消费的图片附件；随 Session Transcript 保留，切换到不支持图片的模型时从 Provider 请求中省略。
_Avoid_: image text, binary output

**Write Tool**:
Built-in Tool Set 中创建或完整覆盖一个 UTF-8 regular file 的 Tool；不提供 append 或权限修改模式。
_Avoid_: file writer, append tool

**Edit Tool**:
Built-in Tool Set 中对一个文件执行一批定向文本替换的 Tool；优先精确匹配，必要时使用规范化后的模糊匹配，整批替换基于原内容验证唯一性与不重叠性后写回。
_Avoid_: patch tool, fuzzy editor, replace tool

**Bash Tool**:
Built-in Tool Set 中执行 one-shot、非交互、非 login command 的 Tool；模型侧名称为 `bash`。Unix 优先使用 Bash，找不到时回退 `sh`；Windows 需要可用的 Bash。
_Avoid_: shell tool, terminal tool, command tool

**Grep Tool**:
Built-in Tool Set 中按行搜索文件内容的 Tool；模型侧名称为 `grep`，经 Managed Binary `rg` 查询单个文件或目录，尊重 `.gitignore`。
_Avoid_: search tool, ripgrep wrapper, content finder

**Find Tool**:
Built-in Tool Set 中按 glob 查询路径名称的 Tool；模型侧名称为 `find`，经 Managed Binary `fd` 搜索，尊重 `.gitignore`。
_Avoid_: file search, fd wrapper, glob tool

**Ls Tool**:
Built-in Tool Set 中列出一个目录直接子项的非递归 Tool；模型侧名称为 `ls`，返回按字母序排列的纯文本条目，目录带 `/` 后缀，包含 dotfiles。
_Avoid_: list tool, directory reader, recursive ls

**Tool Result**:
一次 Tool Call 完成后回填给模型与 Session Transcript 的结果；由模型可见的 content 与可选的 details 组成，失败时以 isError 标记。
_Avoid_: Canonical Tool Result, tool response, tool output, nextArguments

**LLM Provider**:
向 Harness 提供模型推理能力的上游服务，例如 DeepSeek、OpenAI 或 Anthropic。
_Avoid_: search provider, backend

**Provider Adapter**:
把 Harness 的 provider-neutral Completion 请求翻译为某个 LLM Provider wire protocol 的边界组件；0.0.1 只注册 `openai-completion`。
_Avoid_: SDK, API client, provider plugin

**Reasoning Effort**:
Provider-neutral 的离散模型推理投入档位；集合与顺序由 Provider Type 的代码常量定义，Config 可省略默认档位，但缺失时没有隐式 fallback，需要用户重新选择 model 并显式设置。
_Avoid_: thinking level, reasoning budget, extended thinking

**Provider Stream Event**:
Provider Adapter 归一化后的 streaming 进度事件；它以完成或失败作为唯一 terminal event，Agent Loop 不直接消费上游 chunk。
_Avoid_: provider chunk, raw delta

**Provider Failure**:
LLM Provider 未能返回完整有效响应的 Harness 级故障；不可重试或耗尽重试预算后，它终止当前 Agent Loop，不会转换成 Tool Result。
_Avoid_: tool error, model error, provider exception

**Interrupted Response**:
已产生语义输出但未成功结束的 streaming 响应。它不作为完整 assistant message 写入 Session Transcript。
_Avoid_: partial response, failed message

**Pending Agent Loop**:
因 Provider Failure、Interrupted Response 或进程退出而停在稳定边界、尚未得到完整最终响应的 Agent Loop。恢复 Session 时只能由用户显式重试，不自动请求 LLM Provider。
_Avoid_: unfinished session, pending message, auto-resume

**Approval Policy**:
决定 Tool 调用如何放行的规则。Susan 只采用 Yolo，不提供可选模式或用户确认流程。
_Avoid_: permission mode, auto-approve flag

**Yolo**:
唯一的 Approval Policy：所有 Tool 调用直接放行，不发起确认。
_Avoid_: auto mode, unattended mode

**Session**:
一次连续的对话及其完整消息历史，可落盘并在下次启动时恢复。
_Avoid_: conversation, thread, chat

**Session Store**:
持久化 Session Transcript 的无 UI adapter，位于 Susan Home 内，负责 append-only JSONL 的写入与恢复。
_Avoid_: database, session service

**Session Header**:
Session JSONL 首行的 metadata，包括 version、id、createdAt 与 cwd。
_Avoid_: front matter, metadata block

**Session Format Version**:
Session Header 中用于判定 JSONL schema 兼容性的整数版本；它独立于 npm Package Version，只有持久化格式发生不兼容变化时才升级。
_Avoid_: app version, package version, session version

**Session cwd**:
Session 生命周期内稳定的工作目录，记录于 Session Header，并作为所有 Tool 相对路径的解析基准；它是可见的执行边界，不是 OS sandbox 或权限边界。
_Avoid_: workspace root, project root, sandbox root, Resolved Path, Real Target Path

**Session Record**:
Session JSONL 中 append-only 的事件行；0.0.1 包含 message、usage 与 compaction。
_Avoid_: row, entry

**Session Token Usage**:
一个 Session 内所有已完成 Provider 请求的 input + output token 累计值；每条 usage record 保存一次请求的上游 usage。
_Avoid_: model context, context estimation

**Cached Input Tokens**:
一次 Provider 请求的 usage 中由上游上报的 prompt cache 命中 input tokens 数；仅采用 OpenAI 标准字段 `prompt_tokens_details.cached_tokens`，上游未上报时该值不存在。
_Avoid_: cache tokens, prompt cache hit tokens, 缓存 tokens

**Cache Hit Rate**:
Session 内所有已完成 Provider 请求累计的 Cached Input Tokens 占累计 input tokens 的比例。
_Avoid_: cache ratio, hit ratio, 缓存命中比

**Session Transcript**:
Session 中持久保留、可恢复与审计的完整事件记录。Compaction 不会删除其中的早期内容。
_Avoid_: history, log

**Model Context**:
Harness 为某次模型请求从 Session Transcript 派生的活动上下文，可由早期内容的摘要与近期原文组成。
_Avoid_: history, messages

**Context Estimation**:
基于 provider usage baseline 与 UTF-8 byte / 3 的保守增量估算，用于判断 Model Context 是否接近窗口上限。
_Avoid_: token count, tokenizer

**System Prompt**:
Harness 为每次模型请求注入的行为指令，由身份段、Available tools、Guidelines 与 Session cwd 拼装；Guidelines 来自各 Tool 贡献与常驻条目；不作为用户消息或 Session Transcript 的一部分。取代先前锁定的 canonical 文案（#42）。
_Avoid_: canonical system prompt, user instructions, project rules, custom prompt

**Compaction**:
为延续长 Session，用 rolling structured summary 替代 Model Context 中的早期内容，同时保留近期原文的过程。
_Avoid_: truncation, deletion

**Compaction Checkpoint**:
一次 Compaction 的持久结果，记录 structured summary、保留的原文尾部，以及该范围内读过/改过的文件清单，用于恢复 Model Context。
_Avoid_: snapshot, truncated history

**Susan Home**:
存放 Config、Session Store 与 Managed Binary 的 `.susan` 目录。默认位于用户 home 下；启动时可指定另一个父目录。
_Avoid_: config directory, config root, susan dir, data directory

**Managed Binary**:
Susan Home `bin` 目录中缓存的 `rg` / `fd` 平台二进制，供 Grep Tool 与 Find Tool 在系统 PATH 未提供时使用。
_Avoid_: system binary, tool download, package install

**Config**:
Susan Home 内的用户配置文件 `config.json`；v0.0.1 仅允许 CLI flag 覆盖，不支持环境变量覆盖。拆包目标中，外部修改需要通过 `/reload` 更新运行中的配置；`/model` 的显式选择仍立即生效并影响后续新建 Session。
_Avoid_: settings, preferences

**Resolved Config**:
用户 Config 加上内存默认值与 CLI flag 覆盖后形成的运行时配置。`defaultProvider`、`defaultModel` 与 `defaultReasoningEffort` 均可省略；三者省略时均没有隐式 fallback；`defaultProvider` 省略时后两项可以成对出现或同时省略，成对出现时它们不是 Active Model Configuration。
_Avoid_: effective config, merged config

**Active Model Configuration**:
当前 Harness 请求使用的 provider、model 与 Reasoning Effort；三者完整时才可发起请求。
_Avoid_: session model, transient model, per-message model

**Config Error**:
Config 读取 / 解析 / strict schema / 权限 / provider 选择失败时产生的结构化错误，带 code 与字段 path。
_Avoid_: validation exception, config warning
