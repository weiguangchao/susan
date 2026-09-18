# Release candidate 人工 TUI smoke

每个 TUI Release Candidate 在自动检查通过后，必须在 macOS、Linux、Windows 的真实 80×24 或更大终端中验收。使用 Node 22 或 24，并运行仓库外安装的原始本地 TUI tarball bin，不从 `src` 启动。

## 记录

| Commit | TUI 版本 | tarball SHA-256 | Harness/core 实际版本 | 平台 | 终端 | Node | 执行人 | 日期 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  | macOS |  |  |  |  | 尚未执行 |
|  |  |  |  | Linux |  |  |  |  | 尚未执行 |
|  |  |  |  | Windows |  |  |  |  | 尚未执行 |

## Checklist

- [ ] 启动：`susan --config <dir>` 打开 TUI，终端保持可用，布局在 80×24 下无意外自动换行。
- [ ] 输入：单行、多行、粘贴与全宽字符可编辑并提交；输入 viewport 不吞掉左右边框。
- [ ] 取消：分别在 Provider streaming 与长时间 Bash Tool 运行中取消；界面回到稳定状态，进程按平台保证结束。
- [ ] 恢复：`susan --resume`、`susan --resume --last` 与指定 Session id 可恢复；Pending Agent Loop 不自动请求 Provider。
- [ ] `/new`：空 Session 且 cwd 相同时复用当前 Session；非空 Session 切换成功后才替换当前会话，失败时保留当前会话。
- [ ] `/model`：空闲或 Pending 时可保存并立即应用选择；后续新 Session 沿用选择，失败时保留原模型配置。
- [ ] `/reload`：外部 Config 修改在 reload 前不生效；成功后更新后续请求，失败时保留当前 Harness、Session 与旧配置。
- [ ] 七类 Tool 卡：`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 都显示准确的 requested、running、completed 或 failed 状态与摘要。
- [ ] outside cwd：绝对路径命中 Session cwd 外目标时，执行中卡片显示绝对路径与 `outside cwd`；Yolo 不变成 sandbox。
- [ ] 失败：观察至少一个 Config、路径、Tool 非零退出或 capability failure；信息与退出状态一致。
- [ ] truncation：制造超过 2000 行或 50KB 的输出；卡片显示 truncation details，Bash 截断时显示完整输出文件路径，不出现第二份未截断完成态输出。
- [ ] Session：退出并恢复后，已完成 Tool Result、失败与 truncation 信息保持一致。
- [ ] 退出：`/exit` 与终端中断都能结束进程，不留下占用终端的前台任务。

每项记录“尚未执行”“失败”或“通过”。任一必选项失败或缺失时，记录平台、终端、复现命令、Session id 与可公开的错误输出，并阻止该 TUI Package Version 发布。不再使用 workflow 专用 issue-comment marker。
