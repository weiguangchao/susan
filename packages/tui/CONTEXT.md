# TUI

以终端形态呈现 Session 并接收用户输入的客户端；它消费 Harness，不承担 Agent Loop。Interrupted Response 保留为中断状态；Session Token Usage 与 Cache Hit Rate 进状态栏，累计 Cached Input Tokens 为零时不显示 Cache Hit Rate；启动时 Active Model Configuration 不完整只提示、不打开 Model Picker。

## Language

**Slash Command**:
TUI 本地命令，以 `/` 前缀的规范名标识；由 TUI 拦截执行，不作为用户消息进入 Agent Loop。现行目录为 `/compact`、`/exit`、`/new`、`/model`、`/reload`，没有隐藏别名。
_Avoid_: command, slash, 斜杠指令, `/clear`

**Slash Command Label**:
规范名旁的短展示名；不是身份，也不用于过滤候选。
_Avoid_: description, shortLabel, 命令说明

**Slash Query**:
整段输入为单行、以 ASCII `/` 开头、且不含空白时的输入形状；与光标位置无关。它是 Slash Command Menu 可见的必要条件，不是充分条件。
_Avoid_: slash prefix, filter text, command query

**Slash Command Menu**:
由 Slash Query 派生的 Slash Command 候选列表，不是带开关的独立模式。可见当且仅当输入为 Slash Query，且 Agent Loop 未在进行，且 Model Picker 未打开；可见时输入框里的 Slash Query 就是过滤条件，不显示时 Slash Query 仍留在输入框。它是列出 Slash Command 目录的唯一 TUI 表面：可见时独占输入框上方的活动槽；没有菜单、重试、失败或通知需要展示时，活动槽不显示内容、不占行，也不列出命令。
_Avoid_: command palette, hint bar, 操作台, 命令选择界面, CommandHintLine

**Selected Slash Command**:
Slash Command Menu 可见且过滤后候选非空时，当前被选中的那一项 Slash Command；菜单未显示或候选为空时不存在。
_Avoid_: highlighted row, focused command, active index

**Model Picker**:
TUI 上选择 Active Model Configuration 的表面。由 Slash Command `/model` 打开，或提交/重试时缺任一项时打开；只在 Agent Loop 空闲或 Pending Agent Loop 时切换；浏览从 Config JSON 第一个 provider 起，省略 Model Catalog 的 provider 显示空目录。
_Avoid_: model selector, model menu, 模型选择器

**Tool 账本**:
TUI 上已结束 Tool Call 的记录表面（completed / failed / interrupted）：每条含名称、调用标签、摘要与有限结果行。requested 与 running 的调用不在此表面绘制。
_Avoid_: tool list, tool panel, execution log, tool log, 工具列表

**Package Version**:
用户面对的已发布 npm 包 `@weiguangchao/susan` 的版本。它与 Session Format Version 分属不同版本空间。
_Avoid_: Session version, schema version, 产品版本
