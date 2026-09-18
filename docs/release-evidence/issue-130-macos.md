# #130 macOS 验收记录

macOS 自动验收通过。macOS 人工验收尚未执行；Linux、Windows 本轮未执行。#130 保持未完成，三包 Release Gate 尚未通过。

## 执行条件

- 源码 commit：`f50dcfb441ca3ce518dd9a24f6f2ed5aa2310762`，当前分支 `dev`。
- 执行时仅增加 smoke 保留临时目录的选项及验收文档，没有修改打包源码。此次记录对应下列 SHA-256 的产物。
- 平台：macOS 27.0 / 26A428，arm64；Node v22.23.2；pnpm 10.34.5。
- 执行人：Codex 自动执行。日期：2026-09-17 America/Los_Angeles，UTC 2026-09-18。
- Node 22 由 npm exec 隔离安装，检查进程 PATH 优先使用该 Node，不修改系统默认 Node 24。
- 三包均为 0.0.1；三包命令按 typecheck、test、build、package:smoke 顺序逐包执行。

## 自动结果

| 包 | typecheck | test | build | package:smoke |
| --- | --- | --- | --- | --- |
| core | 通过 | 通过 | 通过 | 通过 |
| Harness | 通过 | 通过 | 通过 | 通过 |
| TUI | 通过 | 通过 | 通过 | 通过 |

共 35 个测试文件、501 个测试通过，core/Harness/TUI 分别为 2/317/182 个测试。TUI 测试输出了两次 `MaxListenersExceededWarning`，提示 process 上有 11 个 beforeExit listeners，未导致测试失败；本轮未定位该 warning 的来源。
所有消费者均在仓库外安装原始 tarball，通过普通 Node 执行；内部依赖由临时 scope registry 指向本地产物。
没有使用 workspace link、源码入口或 tsx。TUI smoke 包含非交互 CLI 检查，不构成人工终端验收。

## 实际产物

| 检查 | tarball | SHA-256 |
| --- | --- | --- |
| core | weiguangchao-susan-core-0.0.1.tgz | `3c4f7c52f5a19b9c188e0c8ab594930d2d494fbf79e3dff6d945490411503c71` |
| harness | weiguangchao-susan-core-0.0.1.tgz | `cd0d98e90023c776f8ee8ccf9ed145853da2bd1c81f434f8c34135c970d966b6` |
| harness | weiguangchao-susan-harness-0.0.1.tgz | `dadd54dcb6137e1f251188f4b578653e55509278262c99dce971fab98113fab9` |
| tui | weiguangchao-susan-0.0.1.tgz | `5a99ac536a7c81252915f5d8ecd8b95ab034d300b704cc6de99bd619bfb9e073` |
| tui | weiguangchao-susan-core-0.0.1.tgz | `cd0d98e90023c776f8ee8ccf9ed145853da2bd1c81f434f8c34135c970d966b6` |
| tui | weiguangchao-susan-harness-0.0.1.tgz | `dadd54dcb6137e1f251188f4b578653e55509278262c99dce971fab98113fab9` |

core 独立 smoke 使用 npm pack，Harness/TUI 使用 pnpm pack，因此 core 有两个实际 archive hash。
已核对两者仅 package.json 字段顺序不同，其余打包文件字节相同；两种产物都原样安装并分别记录，不合并 SHA。
Harness 安装 core 0.0.1；TUI 安装 Harness/core 0.0.1。
所有实际安装依赖版本、package-lock SHA、命令、退出码及日志 SHA 见 [evidence.json](issue-130-macos/evidence.json)，同目录保留全部十二份命令日志。

原始 tarball、完整消费者及 package-lock 保留在本机 `/Users/weiguangchao/workspace/susan-acceptance/issue-130-macos/{core,harness,tui}/`。
这些大文件未提交到 Git；其他机器复核或接续人工验收需要复制这份证据目录。原临时路径已迁移到该持久目录。

## 人工验收与剩余阻塞

人工执行人、真实终端型号与窗口尺寸、逐项观察、Session id 均尚无记录。
[人工清单](../../packages/tui/docs/release-smoke.md) 的全部项目仍为“尚未执行”，包括 /new 空会话复用与失败保留、/model 即时保存、外部 Config 经 /reload 生效及 Session/消息/Pending 保留。

接续 macOS 人工验收时，切换到上述 `tui/consumer`，使用 Node 22 或 24，在真实 80×24 或更大的终端运行 `./node_modules/.bin/susan --config <独立配置父目录>`。
当前消费者的配置仅用于自动错误分支检查，人工执行需提供自己的可用 Config；不要将凭据加入验收记录。
记录该目录 `pack` 中的 TUI、Harness、core SHA，并逐项填写清单。若修复改变产物，重新执行对应自动检查及人工验收。

Linux Node 22/24、Windows Node 22 自动验收以及三平台人工验收尚未执行。本轮按用户要求仅验收 macOS；不关闭 #130，不宣称 Release Gate 通过，也未发布 npmjs 或执行 registry 范围解析检查。
