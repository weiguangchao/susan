# AGENTS.md

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
