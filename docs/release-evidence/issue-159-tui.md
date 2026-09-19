# TUI 目录拆分验收 #159

- 验收日期：2026-09-19 America/Los_Angeles（2026-09-19 UTC）。
- 验收源码：`3fc4897f0d97a93378a3d317f4f96a4174abff36`。
- 拆分前基线：`37e7ce8`，即 #147 开始前的提交。TUI 入口在 Harness 拆分期间未改。
- 环境：macOS、Node `v24.18.1`、pnpm `10.34.5`。
- 范围：[#159](https://github.com/weiguangchao/susan/issues/159) 及父票 [#146](https://github.com/weiguangchao/susan/issues/146) 的 TUI 验收。#155–#158 均已关闭。

## 导出与旧文件

使用 TypeScript AST 提取拆分前后 `packages/tui/src/index.ts` 的命名导出，分别对运行时值和类型排序比较。两者一致：24 个运行时值、28 个类型，无新增、缺失或类别变化。

TUI 的 npm 包不是 library。`package.json` 的 `exports` 在拆分前后都是 `{}`，`bin.susan` 仍为 `./dist/cli.js`，`files` 仍为 `dist`、`THIRD_PARTY_NOTICES`、`CHANGELOG.md`。以下命令无 diff，确认包入口配置本身未改变：

```sh
git diff 37e7ce8 3fc4897 -- packages/tui/package.json packages/tui/scripts/package-smoke.mjs
```

通过 TypeScript `resolveModuleName`（`moduleResolution: Bundler`）检查包入口的所有导出来源，全部可解析。此次拆分涉及的入口解析到各自目录的 `index.ts`：

- `ui/state/`
- `ui/tui/`
- `ui/model-picker/`
- `ui/slash-command-menu/`
- `ui/tool-ledger/`

`ui/input/`、`ui/session-content/`、`ui/status-bar/` 存在，仍为内部 module，不增加包级导出。`core/cli.ts`、`core/config-error.ts`、`core/picker.ts` 按 #146 未拆分，保持原路径。扩展名省略的导出字符串由 TypeScript 自动解析，无需改成显式 `/index`。

使用文件存在性检查确认以下 7 个旧文件均不存在，无旧路径转发壳：

```text
packages/tui/src/ui/state.ts
packages/tui/src/ui/tui.tsx
packages/tui/src/ui/tool-ledger.ts
packages/tui/src/ui/slash-command-menu.ts
packages/tui/src/ui/input-layout.ts
packages/tui/src/ui/model-picker.tsx
packages/tui/src/core/model-picker.ts
```

## 有效行数

使用临时 pnpm dlx 缓存中的 ESLint `9.39.5` 与 `@typescript-eslint/parser` `8.70.0`，通过 `Linter.verify` 检查全部 52 个 `packages/tui/src/**/*.{ts,tsx}` 文件，无解析错误。以 `max-lines` 的 `max: 0`、`skipBlankLines: true`、`skipComments: true` 取得 ESLint 实际计数，再断言每个计数 ≤300，结果全部通过。未向仓库加入 ESLint 依赖或配置，符合 #146 的范围限制。

| 文件（相对于 TUI src） | ESLint 有效行数 |
| --- | ---: |
| `ui/state/harness-event.ts` | 286 |
| `ui/input/layout.ts` | 281 |
| `ui/model-picker/model.ts` | 262 |
| `ui/tool-ledger/presenters.ts` | 225 |

其余 48 个源文件均 ≤199 有效行。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @weiguangchao/susan typecheck` | 通过 |
| `pnpm --filter @weiguangchao/susan test` | 全量 12 个测试文件、182 个测试通过 |
| `SUSAN_SMOKE_KEEP_TEMP=1 pnpm --filter @weiguangchao/susan package:smoke` | Core/Harness/TUI 构建及 TUI 包烟测通过 |

包烟测在仓库外安装原始 tarball，验证 `exports` 仍为 `{}`、deep import 与 library import 被拒绝、CLI `--version` 与 Config 错误路径，以及 Ink 打进 bundle、Harness 保持外部依赖。TUI tarball SHA-256：`80b8dfb10d2aaf6cee02fbf94ffa70eb8600c5a0c3891415654665509d9dd5a9`。

本机烟测产物保留在 `/var/folders/vl/__shcdp52djdnd4hc76s0cr00000gn/T/susan tui smoke-UEeFUP`，该临时目录不属于长期归档。

`packages/tui/test/cli.test.ts` 中 package metadata 用例原先仍期望 `dev` script 为 `tsx src/cli.ts`。`package.json` 自 `6b493ac` 起已是 `tsx src/cli.ts --config ../..`，#155–#158 全量测试因此固定为 181/182。本次把该期望改成与现行 `package.json` 一致，使 #159 的「所有 packages/tui 测试通过」成立。未改 CLI 行为。

现有未提交的 `packages/tui/CONTEXT.md` 修改未纳入本次提交。未执行 Linux、Windows 或 TUI 真终端人工验收；本记录不代表完整产品 Release Gate。
