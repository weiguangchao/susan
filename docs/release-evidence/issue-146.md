# TUI 与 Harness 目录拆分总验收 #146

- 验收日期：2026-09-19 America/Los_Angeles（2026-09-19 UTC）。
- 总验收源码：`bfd1d6454400b47c0ae7900cc47e46a63605efb1`。
- Harness 拆分源码：`8bcff76bf50ed2f68d77063ef12dc56ca3bcfa99`。此后 Harness 源码未改。
- TUI 拆分源码：`3fc4897f0d97a93378a3d317f4f96a4174abff36`。此后 TUI 源码未改；`bfd1d64` 只改 `packages/tui/test/cli.test.ts` 的 package metadata 期望，以及 #159 验收记录。
- 拆分前基线：`37e7ce8`，即 #147 开始前的提交。
- 环境：macOS、Node `v24.18.1`、pnpm `10.34.5`。
- 范围：[#146](https://github.com/weiguangchao/susan/issues/146)。13 个子票 #147–#159 均已关闭。包级记录见 [Harness #154](issue-154-harness.md) 与 [TUI #159](issue-159-tui.md)。

## 子票

| 票 | 内容 | 状态 |
| --- | --- | --- |
| #147 | Susan Home 与 Config | 已关闭 |
| #148 | Session Store | 已关闭 |
| #149 | Tools manager | 已关闭 |
| #150 | openai-completion Provider Adapter | 已关闭 |
| #151 | Built-in Tool Set 超标文件 | 已关闭 |
| #152 | Agent Loop | 已关闭 |
| #153 | Harness Assembly | 已关闭 |
| #154 | Harness 包导出验收 | 已关闭 |
| #155 | TUI 状态归约 | 已关闭 |
| #156 | Model Picker | 已关闭 |
| #157 | TUI 根与呈现 | 已关闭 |
| #158 | Tool 账本、Slash Command Menu、输入 | 已关闭 |
| #159 | TUI 包导出验收 | 已关闭 |

## 目录 module 与旧文件

以下目录均存在，并以 `index.ts` 作为 interface：

Harness：`assembly/`、`adapters/openai-completion/`、`core/harness/`、`core/session/`、`core/config/`、`core/susan-home/`、`core/bash/`、`core/grep/`、`core/find/`、`core/edit/`、`core/tools-manager/`。

TUI：`ui/state/`、`ui/tool-ledger/`、`ui/tui/`、`ui/session-content/`、`ui/status-bar/`、`ui/slash-command-menu/`、`ui/input/`、`ui/model-picker/`。

内部文件集合与 #146 锁定的拆分名单一致。跨 module 引用均经对方 `index.ts`，内部文件不经自己的 index 绕回。测试留在 `packages/*/test/` 扁平目录；相对基线只更新 import 路径，并新增 `packages/harness/test/assembly-running.test.ts`。

通过 TypeScript `resolveModuleName`（`moduleResolution: Bundler`）检查两个包入口的导出来源，全部可解析。拆分涉及的入口解析到各自目录的 `index.ts`。`packages/harness/src/config.ts` 仍为便捷装配，分别引用 `core/config/` 与 `core/susan-home/`。Read、Write、Ls、`core/cli.ts`、`core/config-error.ts`、`core/picker.ts` 按规格未拆分。

以下 18 个旧单文件均不存在，无转发壳：

```text
packages/harness/src/core/config.ts
packages/harness/src/core/session.ts
packages/harness/src/core/harness.ts
packages/harness/src/core/tools-manager.ts
packages/harness/src/core/bash.ts
packages/harness/src/core/grep.ts
packages/harness/src/core/find.ts
packages/harness/src/core/edit.ts
packages/harness/src/core/edit-diff.ts
packages/harness/src/assembly.ts
packages/harness/src/adapters/openai-completion.ts
packages/tui/src/ui/state.ts
packages/tui/src/ui/tui.tsx
packages/tui/src/ui/tool-ledger.ts
packages/tui/src/ui/slash-command-menu.ts
packages/tui/src/ui/input-layout.ts
packages/tui/src/ui/model-picker.tsx
packages/tui/src/core/model-picker.ts
```

相对基线，`CONTEXT-MAP.md`、`packages/core`、两个包的 `package.json` 以及 `packages/harness/scripts/public-api.json` 均无 diff。

## 导出

使用命名导出提取拆分前后 `packages/tui/src/index.ts` 与 `packages/harness/src/index.ts`，分别对运行时值和类型排序比较：

- TUI：24 个运行时值、28 个类型，无新增、缺失或类别变化。
- Harness：27 个运行时值、98 个类型，与拆分前及现有白名单一致。

导出来源改到新目录，公开名字不变。TUI `package.json` 的 `exports` 仍为 `{}`。

## 有效行数

使用临时 pnpm dlx 缓存中的 ESLint `9.39.5` 与 `@typescript-eslint/parser` `8.70.0`，通过 `Linter.verify` 检查全部 74 个 `packages/harness/src/**/*.ts` 与 52 个 `packages/tui/src/**/*.{ts,tsx}` 文件，无解析错误。以 `max-lines` 的 `max: 0`、`skipBlankLines: true`、`skipComments: true` 取得 ESLint 实际计数，再断言每个计数 ≤300，结果全部通过。未向仓库加入 ESLint 依赖或配置，符合 #146 的范围限制。

| 文件 | ESLint 有效行数 |
| --- | ---: |
| `packages/harness/src/core/edit/text-ops.ts` | 300 |
| `packages/harness/src/core/bash/shell.ts` | 299 |
| `packages/harness/src/core/grep/execute.ts` | 287 |
| `packages/tui/src/ui/state/harness-event.ts` | 286 |
| `packages/tui/src/ui/input/layout.ts` | 281 |
| `packages/harness/src/core/harness/harness.ts` | 276 |
| `packages/harness/src/core/find/execute.ts` | 272 |
| `packages/tui/src/ui/model-picker/model.ts` | 262 |
| `packages/harness/src/assembly/index.ts` | 253 |

其余源文件均 ≤225 有效行。

## 自动验证

在 `bfd1d64` 上重新执行包级 typecheck 与测试：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @weiguangchao/susan-harness typecheck` | 通过 |
| `pnpm --filter @weiguangchao/susan-harness test` | 全量 23 个测试文件、321 个测试通过 |
| `pnpm --filter @weiguangchao/susan typecheck` | 通过 |
| `pnpm --filter @weiguangchao/susan test` | 全量 12 个测试文件、182 个测试通过 |

包烟测沿用子票记录，未在本票重复执行。Harness 烟测见 #154，tarball SHA-256：`d342b17f494715963fae0666fa73331a9fa653dd3c8a3b5b790c5b740c05a271`。TUI 烟测见 #159，tarball SHA-256：`80b8dfb10d2aaf6cee02fbf94ffa70eb8600c5a0c3891415654665509d9dd5a9`。

现有未提交的 `packages/tui/CONTEXT.md` 修改未纳入本次提交。未执行 Linux、Windows 或 TUI 真终端人工验收；本记录不代表完整产品 Release Gate。
