# OpenCode、Codex、Pi 的跨 Provider Web Search 架构调研

> 日期：2026-09-02  
> 范围：只研究架构与现状，不替 Susan 做选型。  
> 证据快照：OpenCode [`69c172e`](https://github.com/anomalyco/opencode/tree/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5)、Codex [`9d57be7`](https://github.com/openai/codex/tree/9d57be71ba33bbb2e2dfbed244287f04e01c259f)、Pi [`b8b873b`](https://github.com/badlogic/pi-mono/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)、Pi Skills [`90bb51c`](https://github.com/badlogic/pi-skills/tree/90bb51cae36515a648515b633a81c0c6efc8c74d)。所有事实来自项目官方仓库源码与文档。

## 结论摘要

三套项目没有收敛到“让当前 LLM provider 自己决定如何搜索”这一条路，而是出现了三种可以组合的主流模式：

1. **Provider-independent、client-executed Tool**：Agent 暴露稳定的 `websearch`/`web.run`，自己调用 Exa、Parallel、Brave 或独立 Search API。当前 LLM 是 DeepSeek、Anthropic、OpenAI 还是其他 provider，不决定搜索后端。OpenCode 的本地 `websearch` 是最直接的例子；Codex 的 standalone `web.run` 也属于这一类。
2. **Provider-hosted Tool**：Agent 只把 provider 原生的 `web_search` tool spec 发进模型请求，搜索由模型 provider 执行。优点是原生 grounding、引用和流事件；缺点是能力、参数、计费、可用区域和返回元数据都绑定 provider。Codex 明确支持这条路径，OpenCode 的 GitHub Copilot/OpenAI Responses adapter 也实现了它。
3. **Extension/Skill-mediated Search**：核心只统一普通 function tool 与 tool lifecycle，搜索由扩展或 skill 安装。Pi 的核心没有内建 web-search tool；官方 Pi Skills 用 Brave CLI/skill 补上搜索。这是 provider-neutral 的，但安装、凭据、权限与输出质量由扩展承担。

因此，“统一 web search”可以合理统一的是：面向 agent 的最小输入、一次调用的生命周期、权限入口、错误分类和一份 canonical result DTO。不能假装完全统一的是：hosted provider 的特殊控制项、引用证据、搜索/打开页面的会话状态、流式细节、计费与策略约束。成熟实现倾向于**稳定的产品层能力 + 可替换执行 backend + capability/metadata 保真**，而不是把某一家 provider 的 search API 当作产品协议。

## 一、OpenCode：一个稳定本地 Tool，内部路由 Exa / Parallel

### 1. 产品层和搜索供应商层是两回事

OpenCode 对模型暴露的本地工具名是 `websearch`，输入 schema 固定为 `query`，再加 `numResults`、`livecrawl`、`type`、`contextMaxCharacters` 等可选项。实现注释明确称它是 **provider-independent local web search**，并明确区分“本地 Exa/Parallel 工具”和“由模型 provider 执行的 provider-hosted web search”。这说明其架构边界不是 `LLMProvider.webSearch()`，而是 `Agent Tool -> Search backend adapter`。[本地工具定义与架构注释](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L18-L57)

当前 backend 枚举只有 `exa | parallel`。选择优先级是显式配置、实验 flags，最后按 session id 做稳定分流；API key 也属于 search backend 配置，而不是 LLM model provider 配置。[配置与 backend 选择](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L59-L97)

旧/兼容路径中，本地工具只有在 OpenCode 自家 provider 或 Exa/Parallel flag 开启时进入工具列表，说明“协议上 provider-neutral”不等于“产品上对所有 provider 默认开放”；是否暴露仍然是产品 capability/policy 决策。[工具可见性判断](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/registry.ts#L58-L65) [注册时过滤](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/registry.ts#L291-L303)

### 2. 适配器在内部翻译，不泄漏给模型

同一个 canonical 输入会被翻译成不同 MCP 调用：

- Exa：`web_search_exa({ query, type, numResults, livecrawl, contextMaxCharacters })`；
- Parallel：`web_search({ objective, search_queries, session_id, model_name })`。

也就是说，`query` 可以统一，但 `livecrawl`、`type` 等并不是所有 backend 的共同能力；Parallel 侧甚至需要 session/model 上下文。这种差异被留在 adapter 内部。[两套参数映射](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/websearch.ts#L60-L97)

底层使用 MCP `tools/call` JSON-RPC，请求既接受普通 JSON 也接受 SSE；解析层只抽取第一段文本内容。当前实现设置 25 秒 timeout，V2 还限制单次响应 256 KiB、结果数最多 20、上下文最多 50,000 字符。[MCP 请求和 JSON/SSE 解析](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/mcp-websearch.ts#L4-L96) [V2 限额与错误归一化](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L18-L24) [超时、大小限制和统一失败](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L152-L185)

### 3. 生命周期、权限、结果与引用

执行前，OpenCode 写入 `{ provider }` metadata，并对 `websearch + query` 发起统一 permission assertion；因此审批政策在 agent tool 层，不由 Exa 或 Parallel 各自定义。[审批与 metadata](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L187-L217)

模型最终收到的只是 backend 返回的文本，结构化输出只有 `{ provider, text }`；没有 canonical `sources[]`、title、URL、published date、snippet、citation span。链接如果存在，只是 backend 文本的一部分。因此 UI 可以可靠显示“由 Exa/Parallel 搜索”，但无法仅靠这个协议可靠地渲染统一引用卡片。[输出压平为文本](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L187-L205) [provider 和文本结果](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L219-L248)

### 4. OpenCode 也保留 hosted tool 的另一条通道

在 OpenAI Responses/GitHub Copilot adapter 中，provider tool `openai.web_search[_preview]` 会被序列化成原生 `type: "web_search"`，参数是 `filters.allowed_domains`、`search_context_size`、`user_location` 等，而不是本地 `websearch` 的 Exa 风格参数。[hosted tool 序列化](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/github-copilot/responses/openai-responses-prepare-tools.ts#L79-L96)

这条路径会请求 `web_search_call.action.sources`，并把 provider 发回的 `web_search_call` 映射为 `providerExecuted: true` 的 tool call/result；流式开始事件也单独映射。换言之，hosted search 的来源与生命周期由 provider adapter 保真，而不经过本地 Exa/Parallel adapter。[请求 sources](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/github-copilot/responses/openai-responses-language-model.ts#L220-L246) [provider-executed 结果映射](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/github-copilot/responses/openai-responses-language-model.ts#L633-L649) [流式开始映射](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/github-copilot/responses/openai-responses-language-model.ts#L880-L902)

## 二、Codex：capability-gated 的 hosted / standalone 双路径

### 1. hosted web search：模型 provider 执行

Codex 的 hosted tool spec 将统一配置翻译成 Responses web-search tool：

- `disabled`：不暴露工具；
- `cached`：`external_web_access=false`；
- `indexed`：external access 打开且标记 indexed；
- `live`：`external_web_access=true`；
- 可选保留 allowed domains、approximate location、context size，以及 text/image 搜索类型。

[hosted tool spec](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/core/src/tools/hosted_spec.rs#L1-L48) [配置类型](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/protocol/src/config_types.rs#L369-L500)

hosted 工具并非无条件发送。Codex 先看 provider capability；如果 standalone 工具可用，则不再发 hosted 工具，避免两套 web search 同时竞争。若 standalone 不可用而 provider 声明支持 hosted web search，才构造原生 spec。[两条路径的仲裁](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/core/src/tools/spec_plan.rs#L598-L625)

这使 `ModelProvider` 边界承担的是 **能力声明和 wire API**，而不是假设所有 provider 有同一个 search endpoint。Provider capability 还分别声明 namespace tools、web search 和 external web access。[provider capabilities](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/model-provider/src/provider.rs#L50-L80)

### 2. standalone `web.run`：独立 Search API，仍复用 provider auth/routing

Codex 另有一个 namespace function tool `web.run`。它的 schema 覆盖 `search_query`、`image_query`、`open`、`click`、`find`、PDF screenshot、finance、weather、sports、time 和 `response_length`；这已不是单次“关键词 -> 十条链接”，而是有 reference id 的有状态 browsing/search service。[完整 command schema](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/codex-api/src/search.rs#L31-L213)

standalone 执行器把最近对话、commands、settings、模型名和 token budget 发送给 `SearchClient`。它使用当前 provider 的 API route/auth，但只有 OpenAI、OpenAI actor authorization 或显式声明 `supports_standalone_web_search` 的 provider 才可用。这是一种“搜索执行与主模型 tool protocol 解耦，但服务授权仍经过 provider route”的实现，不是任意 provider 都天然能用。[可用性与设置映射](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/ext/web-search/src/extension.rs#L33-L92) [SearchClient 调用](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/ext/web-search/src/tool.rs#L94-L149)

### 3. 生命周期与 source metadata

Codex 为 standalone search 发出明确的 started/completed item：开始时 action/results 为空，完成时包含归一化的 `Search | OpenPage | FindInPage | Other` action 和 results；legacy 协议也收到 `WebSearchBegin/End`。这是 UI 可依赖的稳定生命周期。[开始、完成与错误传播](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/ext/web-search/src/tool.rs#L131-L188)

Search API 的 `output` 是送回模型的文本；`results` 则是 out-of-band 的 opaque JSON DTO。Codex 有意不把新 result variant 固化进 core schema，以便服务演进而不要求 CLI 发版。[SearchResponse 的文本与结构化结果](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/codex-api/src/search.rs#L297-L304) [app-server 边界的 opaque results](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/ext/items/src/web_search.rs#L7-L45)

这比 OpenCode 本地工具保留了更多 source metadata，但代价是 core 不能静态保证每个 result 都有相同字段。模型端仍收到 plaintext function-call output，并把它标记为 external context。[模型输出转换](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/ext/web-search/src/output.rs#L17-L39)

### 4. approval / policy 不是每次查询的 provider 弹窗

源码中没有为 hosted 或 standalone search 做逐 query 的 `ask`。政策由 `web_search_mode`、provider capabilities、组织 requirements 与 permission profile 共同约束。当前默认 mode 是 cached；当 permission profile 禁用本地权限时，resolver 会在允许的 mode 中收缩到 live/cached/disabled，并且 live/indexed 还要求 provider 允许 external web access。[默认与配置解析](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/core/src/config/mod.rs#L2611-L2634) [每 turn 的 policy 收缩](https://github.com/openai/codex/blob/9d57be71ba33bbb2e2dfbed244287f04e01c259f/codex-rs/core/src/config/mod.rs#L2999-L3041)

这和 OpenCode 的逐 tool permission assertion 是不同政策模型：Codex 主要在“是否暴露、允许何种联网级别”处做门控；工具一旦暴露，搜索调用进入普通 tool lifecycle。

## 三、Pi：核心统一普通 Tool，不把 Web Search 做成 provider feature

### 1. Pi 的统一边界是 function tool protocol

Pi AI 层定义的通用工具只有 `name + description + parameters`。Provider adapter 把它转为各家的 function/tool-use wire format；统一消息协议包含 `ToolCall { id, name, arguments }`、`ToolResultMessage { content, details, isError }` 和 `toolcall_start/delta/end` 流事件。[通用 Tool 与消息类型](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/src/types.ts#L372-L380) [ToolResult 与 Tool schema](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/src/types.ts#L449-L525) [统一流事件](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/src/types.ts#L527-L551)

例如 Anthropic adapter 只把这些普通工具转成 `tool_use` schema，并将 provider 的增量 JSON 映射为统一 `toolcall_*` 事件；它没有把 Anthropic server-side `web_search` 建模为 Pi 的通用 web-search 能力。[Anthropic function tool 序列化](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/src/api/anthropic-messages.ts#L1326-L1366) [Anthropic tool-use 流映射](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/ai/src/api/anthropic-messages.ts#L611-L664)

### 2. 核心没有内建 web search；官方 skill 走 Brave

Pi coding agent 内建工具清单是 read、bash/powershell、edit、write、grep、find、ls，没有 web search。[内建工具清单](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/tools/index.ts#L1-L58)

官方 Pi Skills 的 `brave-search` 则通过本地脚本调用 Brave Search API，凭据是 `BRAVE_API_KEY`，参数有 result count、country、freshness 和是否抓取正文。它输出 title/link/age/snippet/content 的文本块。[skill 用法与输出约定](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/SKILL.md#L1-L79) [Brave API 请求与结果字段](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L56-L108)

这使搜索与当前 LLM provider 完全解耦，但它更像“模型读 skill 后执行脚本”，而不是核心注册的强类型 `websearch` tool。结构化 source 在脚本内部存在，跨到模型时则变成文本约定；没有核心级 citation span 或 canonical source DTO。

### 3. 生命周期、错误与批准由通用扩展机制承担

扩展可以注册真正的 custom tool。Pi 的通用生命周期是 `tool_execution_start -> tool_call -> update -> tool_result -> tool_execution_end`；同一 assistant turn 的 sibling tools 默认并行，preflight 顺序执行，完成事件可交错。[扩展生命周期总图](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/extensions.md#L280-L310) [tool_call 与并行语义](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/extensions.md#L776-L793) [tool_result 中间件](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/extensions.md#L842-L853)

`tool_call` hook 可以修改参数、阻止执行或终止 agent，因此可以实现 search permission gate，但 Pi 没有内建的统一 approval policy。Pi 也明确声明没有内建 sandbox，扩展和工具继承启动用户权限；project trust 只控制是否加载项目资源，不限制加载后的 tool 行为。[安全边界](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/security.md#L1-L35)

Brave 脚本对缺 key、HTTP 非 2xx 以 exit 1 失败；单页抓取失败则降级为每条结果中的 `(HTTP ...)` / `(Error: ...)` 文本，属于 partial success。这也说明若要产品级统一，不能只统一顶层 `isError`，还需要表达每个 source 的抓取状态。[错误与 partial success](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L56-L87) [页面抓取降级](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L127-L164)

## 四、横向比较

| 维度 | OpenCode | Codex | Pi |
|---|---|---|---|
| 默认产品抽象 | 本地 `websearch` | hosted `web_search` 或 standalone `web.run` | 普通 Tool/extension/skill |
| 与当前 LLM provider 的耦合 | 本地路径低；hosted 路径高 | capability 仲裁；standalone 仍依赖受支持 provider route/auth | 普通 client tool 低；核心不提供 search backend |
| backend 选择 | Exa / Parallel，配置或稳定分流 | hosted provider 或 standalone Search API，互斥选择 | 由安装的 extension/skill 决定；官方示例 Brave |
| 模型看到的输入 | 稳定但偏 Exa：query + crawl/type/count | hosted 是 provider spec；standalone 是多 command schema | extension 自定义 JSON schema；skill 可能只是 CLI 用法 |
| 结果 | 本地为文本 + provider metadata | 模型文本 + out-of-band opaque results；hosted 保留原生 item | ToolResult 可承载文本/图片/details；Brave skill 实际输出文本 |
| streaming | 本地 MCP response 可为 SSE，但最终取文本；hosted 有 provider event 映射 | begin/end item；hosted 用 Responses lifecycle | 通用 toolcall start/delta/end + execution lifecycle |
| citations/sources | 本地无强类型 sources；hosted 可请求 sources | standalone results 可带结构化 source；模型输出仍是文本 | 核心可用 details 承载，但官方 Brave skill 未建立核心协议 |
| approval | `websearch` 统一 permission assertion | mode/capability/requirements 门控，无逐 query ask | extension hook 自行 block/confirm；无内建 sandbox |
| fallback | backend 失败归一成 tool failure；没有证据显示自动跨 backend retry | hosted/standalone 在 tool-plan 阶段择一；没有证据显示一次调用失败后静默切换 | skill 自己定义；Brave 页面抓取可 partial success |

## 五、主流架构模式

### 模式 A：稳定的 agent-facing Tool，backend adapter 在内部

这是 OpenCode 本地搜索的形状，也可以用 Pi extension 实现：

```text
LLM provider adapter
        │ 普通 function tool
        ▼
canonical web_search(query, options)
        │
        ├─ Exa adapter
        ├─ Parallel adapter
        ├─ Brave adapter
        └─ future adapter
```

它解决的是“换 LLM provider 不应换搜索能力”。主要风险是 canonical schema 很容易被第一家 backend 的参数污染；OpenCode 当前的 `livecrawl/type/contextMaxCharacters` 就带有这个痕迹。

### 模式 B：provider-hosted tool 保持原生通道

这是 Codex hosted search 和 OpenCode OpenAI Responses adapter 的形状。Agent core 只统一 capability 与生命周期 envelope，provider adapter 保留原生 spec、事件、source metadata。它适合需要 provider grounding、原生 citations 或 provider 负责联网策略的场景，但无法保证跨 provider 行为等价。

### 模式 C：standalone search service 作为普通 namespace tool

Codex `web.run` 比“搜索 API adapter”更进一步：搜索服务自己维护 reference id、open/click/find、页面内容、结构化市场/天气/体育查询。主模型只是在普通 tool loop 中调用它。这能提供稳定产品体验，也能让搜索服务独立演进；但部署、认证、隐私、成本和服务可用性成为新的产品依赖。

### 模式 D：skill/script 组合

Pi 官方 Brave skill 是最薄的方式：核心完全不认识 web search，只教模型调用一个脚本。它非常通用、容易替换，也最适合用户自带工具；但 schema、权限、引用、可观测性和失败处理都不是产品级契约。

### 模式 E：hybrid

Codex 和 OpenCode 的证据都指向 hybrid：本地/standalone 通道提供跨模型的稳定能力，hosted 通道在 provider 原生能力更合适时保留。关键不是两套能力同时暴露，而是先做 capability/policy 仲裁，再只暴露一个明确的搜索 surface。

## 六、哪些可以统一，哪些必须保留差异

### 可以统一

- **最小意图**：`query`；以及经过验证的通用 hints，如 result limit、domain allowlist、freshness/recency、locale/location。
- **执行 envelope**：`call_id`、backend、started/completed/failed/cancelled、latency、是否 provider-executed。
- **canonical source**：`id/refId`、URL、title、snippet、published/age、source type、可选正文、每项 fetch status。
- **错误分类**：configuration/auth、rate limit、timeout、backend unavailable、invalid query/schema、no results、partial source fetch、cancelled。
- **权限入口**：一次统一的 `web_search` capability decision，并把 query/domain/live-network/backend 作为 policy context。
- **可观测性**：选择了哪个 backend、是否 live/cached/indexed、是否 fallback、结果条数与截断原因。

### 不能无损统一

- hosted provider 的原生参数：OpenAI 的 context size/location/domain filters、Exa 的 crawl/type/context characters、Parallel 的 objective/session/model、Brave 的 country/freshness 并不等价。
- hosted search 的 tool-call lifecycle 与 client tool lifecycle：前者由 provider 执行，后者由 agent 执行；审批、重试、取消和计费责任不同。
- citations 的可信度与位置：有的 backend 给结构化 sources，有的只给文本链接，有的给 answer-level citation spans。把它们全压成 `string[]` 会丢失证据关系。
- 有状态浏览：Codex 的 `ref_id/open/click/find` 需要 session-scoped search state，不能由一次无状态 `search(query)` 完整表达。
- 搜索结果和抓取正文：搜索成功但某些页面抓取失败是 partial success，不应被压成单一布尔 `isError`。
- provider 政策与可用性：地区、组织要求、联网模式、模型是否支持 hosted tool 都只能通过 capabilities/policy negotiation 处理。

## 七、供后续 grilling 使用的未决问题

以下是调研暴露出的决策面，不是本报告的答案：

1. Susan 的“统一”目标是只保证所有 LLM 都有搜索，还是还要保证结果结构、引用展示与可复现性一致？
2. Susan 要统一的是一次无状态 search，还是 Codex 式 search/open/click/find 的 browsing session？
3. hosted provider search 是否是一等 backend，还是只允许 client-executed search，从而避免 provider 绑定？
4. canonical schema 应只保留最小公共能力，还是提供 `capabilities + backendOptions` escape hatch？
5. backend 是全局、profile、session 还是单次调用选择？用户能否固定，是否允许自动选择？
6. fallback 是显式策略还是静默行为？若 primary 已产生部分结果，是否还能切换 backend，如何避免重复计费和混合来源？
7. 引用的产品契约是什么：只要 URL、结构化 source cards、claim-level citation spans，还是必须能打开与继续浏览？
8. search 与 fetch 是否拆成两个权限；cached/indexed/live 是否要进入 policy 与 UI？
9. API key 属于 Susan 管理、用户自带，还是复用 LLM provider 身份？缺 key 时是禁用、降级到 hosted，还是报配置错误？
10. 对 DeepSeek 这类 provider，Susan 是否始终发送普通 client function tool，从而使搜索 backend 与 DeepSeek 完全独立？

## 研究边界

- 本报告描述上述 commit 的仓库状态，不推断尚未合并或闭源服务内部实现。
- “没有自动 fallback / 没有逐 query approval”表示在所查执行路径中没有找到相应实现，不等于所有发行渠道永远不存在该能力。
- Pi Skills 是 Pi 作者维护的官方配套仓库，但 skill/script 不是 `pi-mono` 核心内建 tool；报告已分别表述。
