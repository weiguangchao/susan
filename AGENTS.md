# AGENTS.md

## Monorepo 模块

- `packages/tui`：终端客户端，负责 `susan` CLI、用户输入、命令与界面展示。
- `packages/harness`：Agent 运行层，负责模型调用、工具执行、Session、配置与上下文管理，并提供无 UI 的装配 API。
- `packages/core`：共享基础包，目前提供 JSON 类型与检查函数；Agent Loop 位于 Harness 内。

TUI 通过公开 API 调用 Harness，两者共用 Core；Harness 不依赖 TUI。

## 编码规约

- 单文件代码最多 400 行

## Agent skills

### Issue tracker

Issues live as GitHub issues in `weiguangchao/susan`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

先读根 `CONTEXT-MAP.md`，再读相关包的 `CONTEXT.md` 与 `docs/adr/`；系统级 ADR 仍查根 `docs/adr/`。见 `docs/agents/domain.md`。

## Git commit

- subject：`<type>: <description>`
- type：常量，feat / fix / docs / test / chore / refactor / perf / build / ci / revert
- 在实现 issue 时，在 subject 末尾使用 issue 编号，如 `feat: demo commit (#1)`
- description：使用中文，内容精简，技术名词保留英文，禁止模糊描述
