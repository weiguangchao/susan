# AGENTS.md

## Agent skills

### Issue tracker

Issues live as GitHub issues in `weiguangchao/susan`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Built-in tools

Harness 暴露给模型的七个 Tool：

- `read`：分页读文本或读图片附件
- `write`：创建或完整覆盖 UTF-8 文件
- `edit`：一批定向文本替换
- `bash`：真实 Bash 执行 one-shot、非交互 command
- `grep`：经 `rg` 按行搜内容，尊重 `.gitignore`
- `find`：经 `fd` 按 glob 查路径名，尊重 `.gitignore`
- `ls`：列出目录直接子项（非递归，含 dotfiles）

## Git commit

- subject：`<type>: <description>`
- type：常量，feat / fix / docs / test / chore / refactor / perf / build / ci / revert
- 在实现 issue 时，在 subject 末尾使用 issue 编号，如 `feat: demo commit (#1)`
- description：使用中文，内容精简，技术名词保留英文，禁止模糊描述
