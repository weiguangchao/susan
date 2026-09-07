# 同类型 TUI agent 的 Slash Command 菜单

## 范围

本文回答 [调研：同类型 TUI agent 的 Slash Command 菜单](https://github.com/weiguangchao/susan/issues/65)：Claude Code、Codex CLI、OpenCode、Pi、Gemini CLI 如何唤起、过滤、选择与取消 Slash Command Menu；匹配范围是规范名、短标签还是描述；只输入 `/`、关键字过滤、无匹配、回车与 ESC 时各做什么。

调研只使用官方文档与官方仓库源码，不使用二手文章。固定快照如下（均于 2026-09-07 读取）：

- Claude Code：官方文档 [Interactive mode](https://code.claude.com/docs/en/interactive-mode)、[Slash commands](https://code.claude.com/docs/en/slash-commands)、[Fullscreen](https://code.claude.com/docs/en/fullscreen)。TUI 实现源码未作为一手仓库公开，菜单匹配字段与无匹配行为因此只写文档已声明的部分。
- Codex：[`openai/codex@02d4529f55342dee025a5c13f612b72488dfa627`](https://github.com/openai/codex/tree/02d4529f55342dee025a5c13f612b72488dfa627)
- OpenCode：[`anomalyco/opencode@e207624c48159b03dbe17dbc8e51bbcf23e72df5`](https://github.com/anomalyco/opencode/tree/e207624c48159b03dbe17dbc8e51bbcf23e72df5)（`dev`）
- Pi：[`earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282`](https://github.com/earendil-works/pi/tree/9767ba275f3e9a5ee0f5c5342249b629ab1b2282)
- Gemini CLI：[`google-gemini/gemini-cli@85aca163f6c73ac6ce380b5447359146b8adcae4`](https://github.com/google-gemini/gemini-cli/tree/85aca163f6c73ac6ce380b5447359146b8adcae4)

下文均为上述快照可直接验证的行为。五个项目都在快速演进。

## 结论

五个产品都把 `/` 当作输入框开头的 Slash Command 触发器，而不是普通用户消息。菜单的匹配范围并不统一：Codex 与 Pi 只匹配规范名；Gemini 匹配规范名与别名；OpenCode 同时匹配规范名、别名与描述；Claude Code 官方文档只说「跟在 `/` 后的字母用来过滤」，未声明匹配字段。

| 维度 | Claude Code | Codex | OpenCode | Pi | Gemini CLI |
| --- | --- | --- | --- | --- | --- |
| 一手来源 | 官方文档；TUI 源码未公开 | `command_popup.rs` + `slash_input.rs` | `autocomplete.tsx` + `keymap.tsx` | `autocomplete.ts` + `editor.ts` | `useSlashCompletion.ts` + `InputPrompt.tsx` |
| 唤起 | 输入框开头键入 `/` | 首行正在编辑 `/name`，且该 token 对某条命令有 fuzzy 前缀 | 光标在偏移 0 键入 `/`，或首 token 仍是 `/…` 且中间无空格 | 首行、光标前文本以 `/` 开头且尚未出现空格 | 第 0 行、整行 `trim` 后以 `/` 开头（排除 `//`、`/*`） |
| 匹配范围 | 文档未声明字段 | **规范名**；描述只展示 | **规范名 + 别名 + 描述** | **规范名**；描述只展示 | **规范名 + 别名**；描述只展示 |
| 匹配算法 | 「any letters to filter」 | 打开门用 fuzzy；列表用精确 / 前缀 | fuzzysort，display 以 `/`+query 开头则加倍 | 子序列 fuzzy，只看 name | fzf v2；失败则前缀。排序：精确名 > 精确别名 > 前缀名 > 前缀别名 |
| 只输入 `/` | 列出全部可见命令 / skill / plugin / MCP | 列出全部，但隐藏 `quit`/`btw` 这类别名 | 列出全部，按 display 字典序，最多 10 条 | 列出全部 | 列出带 description 且未 hidden 的命令 |
| 无匹配 | 文档未声明 | 完全无 fuzzy 时不打开菜单；已打开则渲染 `no matches`，回车不再选中命令 | 显示 `No matching items` | `getSuggestions` 返回 `null`，菜单消失 | `suggestions = []`，菜单不渲染 |
| 回车 | 文档未声明菜单回车；fullscreen 下鼠标点击接受 | 有选中项则执行并清空输入；无选中项则走普通提交 | 先 hide，再 `onSelect`（内置立即 dispatch；自定义插入 `/name `） | 补全为 `/name ` 后 **直接提交** | 完美匹配则提交；否则 Tab/Enter 接受建议。`autoExecute` 且无补全函数则立即执行，否则只插入文本 |
| ESC | 文档：对话框打开时 Esc 关闭对话框；连按 Esc 清空草稿。未单独声明菜单 | 关闭菜单，**保留** `/token`，并记住该 token，改字前不再弹出 | hide；若输入仍以 `/` 开头且不以空格结尾，**清空输入** | `cancelAutocomplete`，**保留**输入 | `resetCompletionState`，**保留**输入；菜单消失后再连按 Esc 才清空 |

对 Susan 后续规格最有用的共性是：菜单只在**空输入或首 token 仍是 `/…`** 时出现；过滤关键字几乎都取 `/` 之后到第一个空白之前的 token；回车执行高亮项；ESC 取消菜单。分歧集中在三点：描述是否参与匹配、无匹配时是留空态还是收起菜单、ESC 后是否清掉已键入的 `/query`。

## Claude Code

Claude Code 的 TUI 实现不在公开一手仓库里。以下只依据官方文档。

唤起：Interactive mode 的快捷表把「`/` at start」标为 Command or skill。正文写「Type `/` in Claude Code to see the commands available to you, or type `/` followed by any letters to filter。」菜单列出 built-in commands、bundled / user-authored skills，以及 plugins 与 MCP servers 贡献的命令。部分 built-in 因平台或 plan 不可见；另有一批「hidden from the menu by design」，必须键入全名才能跑。[Interactive mode · Commands](https://code.claude.com/docs/en/interactive-mode)

Slash commands 文档补充可见性开关：skill frontmatter `user-invocable: false` 会从 `/` menu 隐藏，并且即使用户键入 `/name` 也不执行；`argument-hint` 会在 autocomplete 中提示参数形状。`skillOverrides` 的 `"off"` 同时从 `/` menu 隐藏。[Slash commands · frontmatter](https://code.claude.com/docs/en/slash-commands)

选择：fullscreen 文档写 `/` command list 响应鼠标：hover 高亮，click 接受。[Fullscreen rendering](https://code.claude.com/docs/en/fullscreen) 键盘回车是否执行高亮项、无匹配时菜单是否保留，官方文档没有写。

取消：总快捷表写「When a dialog is open, `Esc` closes the dialog」。连按 `Esc` 在输入非空时清空草稿并写入 history。Vim 模式下单独的 `/` 会打开 reverse history search，空搜索提示「press `Esc` then `i` then `/` to open the command menu instead」。这些都是官方文档，但不能据此推断非 vim 下 Slash Command Menu 的 ESC 是否清输入。

**一手来源：** [code.claude.com/docs/en/interactive-mode](https://code.claude.com/docs/en/interactive-mode)、[code.claude.com/docs/en/slash-commands](https://code.claude.com/docs/en/slash-commands)、[code.claude.com/docs/en/fullscreen](https://code.claude.com/docs/en/fullscreen)。

## Codex

唤起发生在 composer 首行、光标仍停在初始 `/name` token 内。`SlashInput::is_editing_command_name`：裸 `/`（name 为空且 rest 为空）为真；非空 name 则要求 `has_slash_command_prefix`。后者对全部可见命令的规范名做 `fuzzy_match`。`/ test` 这种「斜杠后立刻空白」不会打开菜单；`/zzz` 对任何命令都无 fuzzy 时也不打开。[`slash_input.rs` `is_editing_command_name`](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/chat_composer/slash_input.rs)、[`slash_commands.rs` `has_slash_command_prefix`](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/slash_commands.rs)、composer 测试 `slash_popup_activated_for_bare_slash_and_valid_prefixes` / `slash_popup_not_activated_for_slash_space_text_history_like_input`。

过滤字符串是首行第一个 `/` 后的第一个非空白 token；`/clear something` 仍按 `clear` 过滤。[`CommandPopup::on_composer_text_change`](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/command_popup.rs)

列表匹配只看规范名（`command.command()` / service-tier `name`），分 exact 与 prefix 两档，大小写不敏感。描述只用于展示。空 filter 隐藏别名 `quit`（`exit`）与 `btw`（`side`），一旦用户键入对应前缀再显示。`/ac` 的 prefix 列表不含 `compact`（测试 `prefix_filter_limits_matches_for_ac`），但打开门仍可能因 fuzzy 而对 `/ac` 弹出菜单，此时列表渲染 `"no matches"`。[`CommandPopup::filtered`](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/command_popup.rs)、[`WidgetRef` `"no matches"`](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/command_popup.rs)

回车：有 `selected_item` 则 `InputResult::Command`（或带参 / service-tier），并清空 textarea。无选中项则退回 `handle_key_event_without_popup`。Tab 默认把高亮命令补成 `/name `，不立刻执行（`/skills` 例外）。[``handle_key_event_with_slash_popup``](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/chat_composer/slash_input.rs)

ESC：关闭 popup，草稿不变，把当前 `/name` token 记入 `dismissed_command_token`；token 不变则 `sync_command_popup` 不再打开。测试 `esc_dismisses_slash_popup_while_idle` 断言 `/rev` 在 Esc 后仍在输入框。[`slash_input.rs` Esc 分支与测试](https://github.com/openai/codex/blob/02d4529f55342dee025a5c13f612b72488dfa627/codex-rs/tui/src/bottom_pane/chat_composer/slash_input.rs)

## OpenCode

TUI 文档写「type `/` followed by a command name」。实现上，autocomplete 在光标偏移 0 看到 `/` 时 `show("/")`；之后只要 `value.startsWith("/")` 且光标前没有空白，就保持或重新打开。出现空格、光标退到触发点之前、或 `/cmd arg` 后再跟第二个 token，则 hide。[`autocomplete.tsx` `onInput` / `show`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/component/prompt/autocomplete.tsx)、[TUI docs · Commands](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/web/src/content/docs/tui.mdx)

候选项来自 keymap 里带 `slashName` 的 palette 命令，加上 server custom / MCP command（skill 源不进菜单）。display 是 `/` + 规范名，aliases 以 `/alias` 形式挂上，description 来自 command `desc`/`title`。列表先按 display `localeCompare`。[`useCommandSlashes`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/keymap.tsx)、[`commands()`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/component/prompt/autocomplete.tsx)

空搜索返回全部；非空时 fuzzysort 的 keys 是：(1) `value ?? display`（规范名），(2) **`description`**（仅 `/` 模式），(3) `aliases`。display 以 `/`+search 开头则 score ×2，`limit: 10`。无匹配时仍渲染一行 `No matching items`。[`options()` / `No matching items`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/component/prompt/autocomplete.tsx)

默认键：`prompt.autocomplete.select = return`，`hide = escape`，`complete = tab`，上下为 `up/ctrl+p`、`down/ctrl+n`。[`keybind.ts`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/config/keybind.ts)

回车 / Tab：`select()` → `hide()` → `option.onSelect()`。内置 slash 的 `onSelect` 是 `keymap.dispatchCommand`；server/custom 则插入 `/name `。`hide()` 在 `/` 模式且当前文本仍以 `/` 开头、不以空格结尾时，会删掉从开头到光标的全部内容——因此 Esc 取消菜单会清掉 `/query`，而不是留下半成品。[`select` / `hide`](https://github.com/anomalyco/opencode/blob/e207624c48159b03dbe17dbc8e51bbcf23e72df5/packages/tui/src/component/prompt/autocomplete.tsx)

## Pi

官方 TUI README：「Type `/` to see slash commands」。[`packages/tui/README.md`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/README.md)

`CombinedAutocompleteProvider.getSuggestions`：光标前文本以 `/` 开头且还没有空格时，进入命令名补全。`prefix = textBeforeCursor.slice(1)`。空 prefix 时 `fuzzyFilter` 原样返回全部命令。非空时只对 **`item.name`** 做子序列 fuzzy（大小写不敏感，允许空白 / `/` 分 token）。`description` 与 `argumentHint` 只拼进展示文案，不参与打分。零匹配返回 `null`，编辑器因此收起菜单而不是画空态。[`autocomplete.ts` slash 分支](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/autocomplete.ts)、[`fuzzy.ts` `fuzzyFilter`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/fuzzy.ts)

菜单只允许在编辑器第一行。[`editor.ts` `isSlashMenuAllowed`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/components/editor.ts)

选择：`tui.select.confirm`（默认 Enter）先 `applyCompletion`，slash 分支写成 `/${item.value} `（规范名后加空格），然后 **fall through 到 submit**，立刻执行该 Slash Command。`tui.input.tab` 同样补全，但补完后 `return`，不提交。`tui.select.cancel`（默认 Escape / Ctrl+C）只 `cancelAutocomplete`，输入保留。[`editor.ts` autocomplete 键处理](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/components/editor.ts)、[`keybindings.ts` `tui.select.confirm` / `tui.select.cancel`](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/keybindings.ts)

维护者在 issue #5593 明确：Tab 后故意不立刻再打开参数补全，以便用户选择「直接回车执行」或「再键入空格打开参数 autocomplete」。

## Gemini CLI

官方命令文档只罗列各 `/` 命令，并写 `/chat` 与 `/resume` 的子菜单按 unique prefix 合并。交互细节在源码。[`docs/reference/commands.md`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/docs/reference/commands.md)

唤起：`cursorRow === 0` 且 `isSlashCommand(currentLine.trim())`。`isSlashCommand` 要求以 `/` 开头，但排除 `//` 与 `/*`。[`useCommandCompletion.tsx`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/cli/src/ui/hooks/useCommandCompletion.tsx)、[`commandUtils.ts` `isSlashCommand`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/cli/src/ui/utils/commandUtils.ts)

`useSlashCompletion` 把 query 去掉开头 `/` 后按空白切成 path。空 `partial`：当前层全部「有 `description` 且 `!hidden`」的命令。非空：对 **name 与 altNames** 建 fzf 索引（`casing: case-insensitive`），**不索引 description**。fzf 失败则退回 name/alias 前缀。排序固定为：精确 name、精确 alias、前缀 name、前缀 alias。无匹配则 `setSuggestions([])`；`SuggestionsDisplay` 在 `suggestions.length === 0` 时返回 `null`。[`useSlashCompletion.ts`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/cli/src/ui/hooks/useSlashCompletion.ts)、[`SuggestionsDisplay.tsx`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/cli/src/ui/components/SuggestionsDisplay.tsx)

`showSuggestions` 在 SLASH 模式下等于「有 loading 或 suggestions.length > 0」。因此无匹配时菜单直接消失。

回车 / Tab 都绑定 `suggest.accept`。[`docs/reference/keyboard-shortcuts.md`](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/docs/reference/keyboard-shortcuts.md) 若 `isPerfectMatch`（当前层存在同名且带 `action` 的命令），Enter 走 `SUBMIT`，直接 `handleSubmit(buffer.text)`。否则 Enter 在 slash 路径上：命令 `isAutoExecutableCommand`（`autoExecute ?? false`）且没有 `completion` 函数则补全后立刻提交；否则只把建议插入输入框。[`InputPrompt.tsx` perfect match / ACCEPT_SUGGESTION](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/cli/src/ui/components/InputPrompt.tsx)

ESC：建议可见时 `resetCompletionState()`，输入保留。建议消失后再连按 Esc，才按 `Esc Esc` 规则清空输入或 rewind。[`InputPrompt.tsx` ESC]、[keyboard-shortcuts · `Esc` pressed twice](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/docs/reference/keyboard-shortcuts.md)

## 对 Susan 的对照（不决策）

Susan 已有 `/exit`、`/new`、`/model`，地图要求空输入框键入 `/` 唤起目录，并支持关键字匹配、高亮、方向键、回车执行、ESC 退出。五个产品里：

1. **唤起**：全部要求 `/` 出现在输入开头（或首行开头），没有人在行中随意 `/` 打开 Slash Command Menu。
2. **匹配字段**：只要三个内置命令、且地图已写「关键字匹配」，最接近的现成做法是 Codex/Pi 的「只匹配规范名」，或 Gemini 的「规范名 + 别名」。OpenCode 把描述纳入 fuzzy，会让 `/clear` 这类隐藏别名是否入菜单的问题更敏感。
3. **只输入 `/`**：全部展示完整可见目录；Codex 会藏纯别名行。
4. **无匹配**：Codex/OpenCode 留空态文案；Pi/Gemini 收起菜单。Claude Code 文档未声明。
5. **回车**：Codex / OpenCode 内置 / Pi 都是「执行高亮命令」；Gemini 对需要参数的命令可能只插入文本。
6. **ESC**：Codex / Pi / Gemini 保留 `/query`；OpenCode 清掉它。Claude Code 文档只保证对话框能被 Esc 关掉。
