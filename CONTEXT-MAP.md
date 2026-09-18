# Context Map

个人使用的最小化 coding-agent 产品：TUI 作为客户端消费 Harness，命令为 `susan`。

## Contexts

- [Harness](./packages/harness/CONTEXT.md): 围绕 LLM 的运行外壳
- [TUI](./packages/tui/CONTEXT.md): 以终端形态呈现 Session 并接收用户输入的客户端

## Relationships

- **TUI → Harness**: TUI 经公开 API 消费 in-process Harness，禁止 deep import
- **Harness ↛ TUI**: Harness 零依赖 TUI
- **TUI → Harness Assembly**: TUI 调用 Harness Assembly；Assembly 接收结构化 options，不接收 argv，返回可分支结果，不渲染
