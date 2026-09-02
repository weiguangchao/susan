# TUI 布局与交互原型（throwaway）

回答 [原型：TUI 布局与交互（消息流、Tool 过程、审批弹窗）](https://github.com/weiguangchao/susan/issues/11) 的粗糙可运行原型。模型响应全部 mock，不接真实 API；读文件 Tool 会真实读取文件以产生真实的行数/字节摘要。

## 运行

```sh
npm install
npm run prototype
```

## 演示命令

在输入框输入以下命令后按 Enter：

- `/demo tool`：触发读文件 Tool（真实读取 `AGENTS.md`），演示审批弹窗、读取中、结果摘要；Enter 允许、Esc 或 Ctrl+C 拒绝。
- `/demo retry`：演示自动重试临时状态「429 · 2 秒后重试（1/2）」与倒计时，随后重试成功继续流式回复。
- `/demo fail`：演示两次重试后最终 Provider Failure 卡片（安全摘要 + request_id），Enter 手动重试、Esc 放弃。
- `/demo interrupt`：演示长流式回复，按 Ctrl+C 中断，形成 Interrupted Response 标记。
- `/demo pending`：演示恢复 Session 时 Pending Agent Loop 提示条；`r` 显式重试、`n` 继续新对话。
- 普通消息：mock 流式回复；消息含文件名（如 `看看 AGENTS.md`）会先回复一句再触发读文件 Tool。

## 快捷键

- `Enter` 发送 · `Esc` 后 `Enter`（部分终端可用 `Alt+Enter`）换行
- `Ctrl+C` 生成中 = 中断当前生成；审批弹窗中 = 拒绝；Tool 执行中 = 中断执行；空闲且有输入 = 清空输入；空闲且输入为空 = 退出
- `Tab` 切换布局 A（底部固定输入区）/ B（输入区内联在消息流末尾）
- `/exit` 退出 · `/clear` 开启新 Session（旧 Session 保留）

## 粗糙点（有意为之）

- 无滚动回看，transcript 只显示最近若干条；不渲染 Markdown；不做输入粘贴、选区与光标跨宽字符对齐。
- mock 回复节奏固定，重试计时用真实倒计时。
- 决议语义（重试边界、截断规则、落盘时机）照抄 #15/#16/#5/#6，本原型不重开。
