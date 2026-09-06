# Release candidate 人工 TUI smoke

每个 Release Candidate 在自动 Release Gate 全绿后，必须分别在 macOS、Linux、Windows 的真实 80×24（或更大）终端中完成一次。Windows 使用 Git for Windows Bash 验证 Bash Tool；另保留自动化的 stock Windows 无 Bash capability failure 检查。

## 记录

| Package Version | Commit | 平台 | 终端 | Node | 执行人 | 日期 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  | macOS |  | 22 或 24 |  |  |  |
|  |  | Linux |  | 22 或 24 |  |  |  |
|  |  | Windows |  | 22 或 24 |  |  |  |

每个平台都先从目标 commit 执行 `pnpm package:smoke`。随后执行 `npm pack`，把新生成的 tarball 安装到仓库外的全新临时目录；人工检查只能运行该安装目录中的 `susan` bin，不从仓库的 `src` 启动。

## Checklist

- [ ] 启动：`susan --config <path>` 打开 TUI，终端保持可用，布局在 80×24 下无意外自动换行。
- [ ] 输入：单行、多行、粘贴与全宽字符可编辑并提交；输入 viewport 不吞掉左右边框。
- [ ] 取消：在 Provider streaming 与长时间 Bash Tool 运行中分别按取消键；界面回到稳定状态，进程按平台保证结束。
- [ ] 恢复：`susan --resume`、`susan --resume --last` 与指定 Session id 可恢复；Pending Agent Loop 不会自动请求 Provider。
- [ ] 七类 Tool 卡：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 都显示 requested/running/completed 或 failed 的准确状态与摘要。
- [ ] outside cwd：通过绝对路径或 symlink 命中 Session cwd 外目标，Tool Result 与卡片均明确显示 `outside cwd`，但 Yolo 行为不被改成 sandbox。
- [ ] 失败：观察至少一个 Config、路径、Tool 非零退出或 capability failure；稳定 error code、错误信息与退出状态一致。
- [ ] truncation：制造超过 Canonical Tool Result 预算的输出，卡片显示 truncation strategy、retained/total 与可用的 next arguments，不出现未截断的第二份完成态输出。
- [ ] Session：退出并重新恢复后，已完成 Tool Result、失败与 truncation 信息保持一致。
- [ ] 退出：`/exit` 与终端中断都能结束进程，不留下仍占用终端的前台任务。

任一必选项失败时记录平台、终端、复现命令、Session id 与可公开的错误输出，并阻止该 Package Version 发布。

## 发布记录格式

三平台全部通过后，由仓库 OWNER、MEMBER 或 COLLABORATOR 在本仓库任一 issue 中提交一条独立评论。评论必须包含以下逐行 marker；发布 workflow 会读取评论 URL，并把版本、完整 commit SHA、三平台结果和完整 checklist 结论作为 Release Gate 的人工证据：

```text
<!-- susan-release-smoke:v1 -->
Package-Version: 0.0.1
Commit: <main 上的完整 40 位 commit SHA>
macOS: PASS
Linux: PASS
Windows: PASS
Checklist: PASS
```

marker 之外应保留上表的终端、Node、执行人和日期，并记录各平台 `pnpm package:smoke` 与 checklist 的结果。`Checklist: PASS` 表示本页全部必选项均已在三平台完成，不用于豁免单项记录。

## 受控发布

在 GitHub Actions 手动运行 `Release npm package`：

1. 选择 `main`，填写与 `package.json` 完全一致的 version、当前 `main` 的完整 commit SHA，以及上述 issue comment URL。
2. 首次保持 `dry-run` 开启。它会重跑 typecheck、unit tests 和 package smoke，核对目标 commit 的完整 CI jobs、人工记录、`npm pack` 文件清单、npm version、tag 与 GitHub Release 状态，并打印后续计划。
3. 核对 dry-run 后，以相同输入关闭 `dry-run`。workflow 通过 npm trusted publishing/OIDC 发布，不读取长期 npm token，也不会改写版本。

若 npm publish 成功而 tag 或 GitHub Release 创建失败，以相同输入重跑。只有 registry 中既有 tarball 的 integrity 与当前 `npm pack` 完全一致时，workflow 才会跳过不可变 npm version 并补齐缺失的 `v<version>` tag 或 GitHub Release；任何内容或 commit 冲突都会停止。
