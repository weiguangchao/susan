# Tool UI 预览

在项目根目录的交互式终端运行：

```bash
pnpm preview:tools
```

复用正式的 ToolLedgerView、InputLine、StatusBar 和工具指令波浪动画，通过模拟事件驱动正式 TUI reducer。所有状态留在内存，不请求模型、不执行 Tool、不写入 Session。

| 按键 | 操作 |
| --- | --- |
| ← / → | 切换七个 Built-in Tool |
| 空格 | 暂停 / 继续（工具波浪继续播放） |
| r | 回到请求阶段，保留暂停状态 |
| n | 单步前进并暂停 |
| s | 成功 / 失败 / 中断 / 原始样例 |
| v | Susan 布局 / 单独工具区域 |
| l | 标准 / 长内容；原始样例保持 fixture 内容 |
| ↑ / ↓ | 滚动长详情 |
| q / Ctrl+C | 退出 |

自动播放按请求 0.9 秒、运行 4 秒、结果 2.4 秒循环。终端尺寸变化会更新布局。

原始样例来自 `test/fixtures/tui-tool-results.ts`，包含 Bash 失败、diff 和截断提示。长内容场景提供长路径、长命令、多行 diff、Bash 输出和大量查询结果；具体展示内容仍由正式 presenter 决定。

Susan 布局用于观察工具区域与输入框、状态栏的配合，使用模拟用户提示和模型信息。它不是完整 Agent Loop 或 Session scrollback 的回放。等待和执行中的 Tool 名称与指令使用青色波浪；输入框保持静态。

已确认的独立动画原型保存在 `prototype/tool-command-wave` 分支，入口为 `pnpm preview:tool-animation`。确认结论：移除 Waiting... / Working... 字样，直接在工具名称和调用指令上渲染 180ms 波浪，完成后显示结果。
