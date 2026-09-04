# Codex、Pi、OpenCode 的终端式 Web Search 执行路径调研

> 日期：2026-09-02  
> 范围：只回答“Web Search 是否以及如何通过终端命令执行”，不替 Susan 做产品选择。  
> 证据快照：Codex [`eb10d91`](https://github.com/openai/codex/tree/eb10d91e48ccbd0930427461fb392337addb1ac0)、Pi core [`b8b873b`](https://github.com/badlogic/pi-mono/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)、Pi Skills [`90bb51c`](https://github.com/badlogic/pi-skills/tree/90bb51cae36515a648515b633a81c0c6efc8c74d)、OpenCode [`69c172e`](https://github.com/anomalyco/opencode/tree/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5)。事实只取自这些官方仓库的源码与文档。

## 结论先行

三个项目的正式路径并不相同：

| 产品/路径 | 模型看到什么 | 实际执行者 | 是否执行终端命令 | 是否需要通用 shell | 搜索服务/凭据 |
|---|---|---|---|---|---|
| Codex standalone `web.run` | 专用 namespace tool | Codex 内置 HTTP client 调 `alpha/search` | 否 | 否 | 复用受支持 model provider 的 route/auth |
| Codex hosted `web_search` | provider-hosted tool | model provider | 否 | 否 | provider 能力与身份 |
| Codex 手工 `exec_command` + `curl`/CLI | 通用 shell tool | 本地进程 | 是 | 是 | 由模型选的命令自行承担 |
| Pi core | 没有内建 Web Search；有 `bash`/`powershell` | 本地 shell | 搜索本身不在 core | 是（若用脚本搜） | core 不配置 |
| Pi 官方 `brave-search` skill | skill 文本 + 通用 `bash` | 本地 `search.js`，再调 Brave API | **是** | **是** | `npm install` + `BRAVE_API_KEY` |
| OpenCode `websearch` | 专用 `websearch` tool | OpenCode HTTP client 调 Exa/Parallel MCP | 否 | 否 | Exa/Parallel；环境变量可覆盖/供 key |

因此，最接近“**不配置 Search Backend，Web Search 使用终端命令**”的已观察方案只有 **Pi core + 官方 `brave-search` skill**，但这句话必须加两项限定：

1. “不配置”只表示 Pi core 没有 Search Backend 配置面；skill 仍固定选择了 **Brave** 这个 backend。
2. 用户仍需运行 `npm install` 并设置 `BRAVE_API_KEY`；它不是零安装、零凭据的搜索。

若“不配置 Search Backend”是指“产品完全不知道搜索，只让模型自由选择 `curl`、某个 CLI 或脚本”，Codex、Pi、OpenCode 的通用 shell 理论上都能这样做；但那是**通用命令执行的涌现用法**，不是 Codex/OpenCode 的正式 Web Search 架构，也不自带统一来源、引用、错误或权限契约。

## 一、Codex：正式 Web Search 与 shell 是两条独立路径

### 1. Standalone `web.run` 是专用 Tool，不是终端命令

Codex 把 standalone search 注册为 namespace `web` 下的 `run` tool，直接向模型暴露 JSON schema；模型选择的是 `web.run({ search_query: ... })`，不是一段 shell 字符串。[`web.run` 的名称、schema 与直接暴露](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/ext/web-search/src/tool.rs#L37-L73)

它支持的不只是 search：同一 schema 还有 image search、open、click、find、PDF screenshot、finance、weather、sports 与 time。换言之，这是专用、有引用状态的 search/browsing service，而不是对 `curl` 的薄包装。[SearchCommands 定义](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/codex-api/src/search.rs#L31-L66)

执行链如下：

```text
模型选择 web.run + JSON commands
  -> Codex WebSearchTool 解析 JSON
  -> 取得当前 provider 的 API route 与 auth
  -> SearchClient POST <provider base URL>/alpha/search
  -> response.output 作为 plaintext tool result 回模型
  -> response.results 作为 opaque DTO 发给 UI/client
```

工具执行器显式构造 `SearchClient`，把 conversation history、model、commands、settings 和 token budget 组成 `SearchRequest`；没有启动子进程，也没有 stdout、stderr 或 exit code。[WebSearchTool 执行链](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/ext/web-search/src/tool.rs#L91-L149) `SearchClient` 用 provider/session auth 对 `alpha/search` 发 HTTP POST，并将 HTTP/解码失败映射为 `ApiError`。[SearchClient endpoint](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/codex-api/src/endpoint/search.rs#L14-L48)

安装与配置方面，它不要求用户安装搜索 CLI。它只在当前 provider 是 OpenAI、使用 OpenAI actor authorization，或显式声明 `supports_standalone_web_search`，并且 `web_search_mode` 未禁用时才注册；因此它虽然不是 hosted tool，却仍复用受支持 provider 的 route/auth，不是任意 LLM provider 都自然可用。[standalone 可用性](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/ext/web-search/src/extension.rs#L33-L55)

结果分两层：`output` 是回给模型的纯文本 external context；`results` 是给客户端的 opaque JSON，可以保留 `ref_id`、URL 和未来字段，但 core 不承诺固定 source schema。[模型侧 plaintext output](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/ext/web-search/src/output.rs#L17-L39) [SearchResponse 的 opaque results](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/codex-api/src/search.rs#L297-L304)

在审批/隔离上，这条路径不经过 `exec_command` 的逐命令 sandbox 参数；是否可用及联网级别由 `web_search_mode`、provider capability 和 search settings 决定。工具执行器会发 started/completed WebSearch item，但请求失败直接成为 fatal tool error，没有 shell exit code。[started/completed 与失败传播](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/ext/web-search/src/tool.rs#L121-L188)

### 2. Hosted `web_search` 也不是终端命令

Codex 还能给 provider 发送原生 hosted web-search spec。`cached`、`indexed`、`live` 决定 external access，配置可带 domain filter、location、context size 和 text/image 类型。[hosted tool spec](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tools/hosted_spec.rs#L8-L45)

Standalone `web.run` 可用时，Codex 不再发送 hosted tool；standalone 不可用且 provider 声明支持 web search 时，才发送 hosted spec。这是两条互斥的正式搜索通道。[两条路径仲裁](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tools/spec_plan.rs#L594-L625)

### 3. `exec_command` + `curl` 是可行的旁路，但不能称为 Codex Web Search

Codex 另有通用 `exec_command`，输入就是模型生成的 `cmd`，输出包含文本、exit code、session id 与截断信息，并带 sandbox/approval 参数。[shell tool 输入输出](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tools/handlers/shell_spec.rs#L24-L114) [shell 输出与审批参数](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tools/handlers/shell_spec.rs#L198-L277)

模型当然可以自行生成 `curl ...`、运行某个 search CLI 或脚本，但此时：命令/程序由模型选择；安装、API key、参数、解析和引用都由该命令承担；网络还受 shell sandbox/policy 管理。该路径需要通用 shell，也不会自动生成 `WebSearchBegin/End` 或 canonical sources。它与 standalone `web.run` 必须分开描述。

## 二、Pi：core 没有搜索，官方 skill 教模型运行脚本

### 1. Pi core 提供的是 skill 装载与通用 shell

Pi 启动时只把 skill 的名称和描述放进 system prompt；任务匹配后，agent 用 `read` 加载完整 `SKILL.md`，然后“跟随说明，使用相对路径引用脚本与资源”。因此是**模型解释 skill 并选择下一次 tool call**，不是 Pi core 把 skill 自动编译成 `web_search` function tool。[Pi skills 装载流程](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/skills.md#L65-L72)

`/skill:brave-search` 只负责显式加载并触发这套说明；skill 可以包含 helper scripts。官方文档把 Pi Skills 仓库明确列为 Web search 等能力的来源，而不是 core 内建工具。[skill command 与结构](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/skills.md#L74-L100) [官方配套仓库](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/skills.md#L229-L232)

### 2. 官方 `brave-search` 的准确执行链

该 skill 明写命令：`{baseDir}/search.js "query"`，可加 `-n`、`--content`、`--freshness`、`--country`。所以**脚本路径与命令形状由 skill 作者规定，具体 query/flags 由模型结合任务选择，最后由模型调用 Pi 的 `bash` tool**。[skill 的命令约定](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/SKILL.md#L25-L52)

```text
Pi 发现 brave-search skill
  -> 模型 read SKILL.md
  -> 模型生成 bash { command: "<skill>/search.js ..." }
  -> Pi 用用户 shell 启动命令
  -> /usr/bin/env node 运行 search.js
  -> search.js fetch Brave Search API
  -> 格式化文本写 stdout；错误写 stderr/exit 1
  -> Pi 合并 stdout + stderr，非零退出转为 tool error
```

`search.js` 的 shebang 是 `#!/usr/bin/env node`。它从 argv 解析 query/flags，读取 `BRAVE_API_KEY`，然后请求 `https://api.search.brave.com/res/v1/web/search`；Brave JSON 中的 title、URL、description、age 被整理后逐条打印成文本。[脚本参数与凭据](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L1-L65) [Brave HTTP 请求与字段映射](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L66-L108)

安装要求不是零：skill 要求 Brave Search API 账户、subscription/key、shell 环境中的 `BRAVE_API_KEY`，并在 skill 目录运行一次 `npm install`。[setup 要求](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/SKILL.md#L9-L23)

Pi 的 bash tool 用 `child_process.spawn` 启动配置的 shell，stdout 和 stderr 都喂给同一个 accumulator；命令非零退出时抛出包含已收集文本及 exit code 的错误，零退出则把文本作为普通 tool result。[spawn 与 stdio 合并](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/tools/bash.ts#L83-L142) [exit code 转换](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/tools/bash.ts#L454-L483)

这会产生一个值得保留的细节：顶层 Brave API/配置错误 `exit 1`，因此成为 tool error；“没有结果”打印到 stderr 但 `exit 0`，在 Pi 看来仍是成功；单页抓取失败则被编码成每条结果里的 `(HTTP ...)` 或 `(Error: ...)` 文本，整体仍成功。[顶层成功/失败语义](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L167-L200) [页面抓取的 partial failure](https://github.com/badlogic/pi-skills/blob/90bb51cae36515a648515b633a81c0c6efc8c74d/brave-search/search.js#L127-L164)

输出虽然逐条包含 title/link/snippet，但跨过 shell 边界后只是文本，没有 core 级 `sources[]` 或 citation span。要把它做成结构化来源，需要另加解析/Tool 契约，不能从 Pi core 的现状直接推得。

### 3. 审批与 sandbox

Pi project trust 只决定是否加载项目 skill 等资源，不限制加载后工具能做什么；Pi 明确没有内建 sandbox，shell、package install 与 extension 都继承启动 Pi 的用户权限。[Pi 安全边界](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/security.md#L3-L35)

因此官方 Brave skill 的默认路径需要通用 shell，且没有专属“搜索审批”。若需要逐查询批准、命令 allowlist 或网络隔离，必须由 extension/tool hook 或外部 OS/container policy 补上；不能把 project trust 当作执行审批。

## 三、OpenCode：模型用专用 `websearch`，实现直接发 HTTP MCP

OpenCode 明确把本地搜索定义成 provider-independent `websearch` tool，并说明它直接调用 Exa/Parallel backend，与 provider-hosted search 分离。[工具定位与输入 schema](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L18-L57)

它的执行链是：模型给 `query` 等结构化参数；OpenCode 选择 Exa 或 Parallel；HTTP client 向 MCP endpoint POST `tools/call`；响应可为 JSON 或 SSE，最后抽取文本返回模型。这里没有 shell、可执行文件、stdout/stderr 或进程 exit code。[MCP HTTP 调用](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L99-L185) [backend 参数映射与文本输出](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L187-L248)

Backend 确实存在：默认按 session id 稳定分到 Exa/Parallel，也可以用 `OPENCODE_WEBSEARCH_PROVIDER`/feature flags 选择；`EXA_API_KEY`、`PARALLEL_API_KEY` 来自环境变量。没有 key 时某些产品 endpoint 仍可能工作，不等于“没有 Search Backend”。[backend 与 key 配置](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L59-L97)

搜索调用前会以 `websearch + query` 做 permission assertion。底层 HTTP 非成功、timeout、超限或解析失败最终统一成 ToolFailure；结果是 `{ provider, text }`，没有 canonical structured sources。[权限与错误归一](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/tool/websearch.ts#L192-L252)

OpenCode 同时注册了通用 shell 和 `websearch`，而且分别拥有 tool id；这证明 shell 不是 websearch 的实现细节。[registry 中的独立工具](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/registry.ts#L101-L117) [内建工具列表](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/tool/registry.ts#L209-L249)

## 四、“终端式搜索”其实有三种不同产品含义

### A. 自由 shell

模型自由选择 `curl`、Python、npm CLI 或任意已安装程序。产品只提供通用 command tool。

- 优点：core 不认识 backend；接入最快。
- 代价：行为取决于 PATH/OS/安装状态；命令生成与 quoting 属于模型行为；结果、引用、错误、网络权限、凭据泄漏风险都不统一。
- 观察到的对应：三个 coding agent 的 shell 都可被这样使用，但它不是 Codex/OpenCode 正式搜索路径。

### B. Skill 约定 + 固定脚本

Skill 告诉模型运行仓库/skill 中的固定程序，模型只填 query/options。

- 优点：仍无需 core Search Backend registry；脚本可独立替换。
- 代价：仍依赖通用 shell；协议是自然语言约定，除非另加 wrapper；安装与 key 在产品配置之外，但没有消失。
- 观察到的对应：Pi 官方 `brave-search`。

### C. 专用 Tool 内部启动 CLI

模型看到 `web_search(query)`，产品内部固定启动一个可执行文件，并把 process output 转成 Tool result。

- 优点：模型协议稳定，也能统一 permission/error/source parsing。
- 代价：产品仍需定义 executable discovery、version、install、credential、timeout、output schema 和 sandbox；实际上形成了一个 process-backed backend adapter。
- 本次三个项目中**没有观察到正式 Web Search 采用这一形状**。Codex/OpenCode 的专用搜索都走 HTTP，Pi 则直接让模型用通用 bash。

## 五、仍需由 Susan 决定的问题（本报告不代答）

1. “终端命令”指 A（自由 shell）、B（skill + 固定脚本），还是 C（专用 Tool 内部启动 CLI）？
2. 模型是否仍应看到稳定的 `web_search(query, maxResults)`，还是只看到通用 `bash(command)`？
3. 命令由模型自由选择，还是 Susan 固定 executable/script，只让模型提供参数？
4. Susan 是否承担 CLI 的发现、安装、版本检查与跨平台路径，还是把这些都视为用户环境前置条件？
5. “无需配置”是只取消 TUI/config-file 中的 backend 选择，还是也要求零 API key、零账号、零安装？后者与 Pi Brave 方案不相符。
6. 如果需要凭据，放在 shell env、外部 CLI 自己的 credential store，还是 Susan 的 secret/config 系统？
7. 是否允许通用 shell；若只为搜索开放它，能否接受任意命令能力随之进入产品？
8. 搜索调用复用通用 command approval/sandbox，还是要独立的 `web_search` permission，让用户只批准 query 而不是整段 shell？
9. stdout 与 stderr 是合并还是分开；非零 exit、timeout、无结果、部分页面抓取失败分别如何映射？
10. 输出只作为模型可读文本，还是 Susan 必须解析为稳定 `sources[]` 并展示引用？若要解析，CLI 输出是否必须是版本化 JSON/JSONL，而不能是人类文本？
11. 是否需要 Codex 式 `search/open/click/find` 的 session/ref 状态；若需要，单次无状态 CLI 是否足够？
12. Windows/macOS/Linux 的 shell、quoting、shebang、Node runtime 与网络 sandbox 差异是否属于 v1 承诺？

## 研究边界

- “没有观察到”指上述固定 commit 的公开源码路径；不推断闭源服务内部实现。
- Codex standalone search 的远端 `alpha/search` 内部如何选择搜索引擎不在公开 client 源码中，因此本报告只确认 client 的调用边界，不猜测服务实现。
- OpenCode 无 key 时 endpoint 的服务端额度/身份策略不由公开 client 代码完整定义，因此不把“key 可省略”解释成“没有 backend 或永远免费”。
- Pi Skills 是 Pi 作者维护并由 Pi 官方文档链接的配套仓库，但不属于 `pi-mono` core；两者已严格分开。
