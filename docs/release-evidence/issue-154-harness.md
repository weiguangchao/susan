# Harness 目录拆分验收 #154

- 验收日期：2026-09-18 America/Los_Angeles（2026-09-19 UTC）。
- 验收源码：`8bcff76bf50ed2f68d77063ef12dc56ca3bcfa99`。
- 拆分前基线：`37e7ce8`，即 #147 开始前的提交。
- 环境：macOS、Node `v24.18.1`、pnpm `10.34.5`。
- 范围：[#154](https://github.com/weiguangchao/susan/issues/154) 及父票 [#146](https://github.com/weiguangchao/susan/issues/146) 的 Harness 验收。#147–#153 均已关闭。

## 导出与旧文件

使用 TypeScript AST 提取拆分前后 `packages/harness/src/index.ts` 的命名导出，分别对运行时值和类型排序比较。两者均与 `packages/harness/scripts/public-api.json` 一致：27 个运行时值、98 个类型，无新增、缺失或类别变化。

以下命令无 diff，确认包入口配置和白名单本身未改变：

```sh
git diff 37e7ce8 8bcff76 -- packages/harness/package.json packages/harness/scripts/public-api.json
```

通过 TypeScript `resolveModuleName`（`moduleResolution: Bundler`）检查包入口的所有导出来源，全部可解析。此次拆分涉及的入口解析到各自目录的 `index.ts`：

- `assembly/`
- `adapters/openai-completion/`
- `core/harness/`、`core/config/`、`core/susan-home/`、`core/session/`
- `core/bash/`、`core/grep/`、`core/find/`、`core/edit/`

`core/tools-manager/index.ts` 存在，仍为内部模块，不增加包级导出。`src/config.ts` 按 #146 保留为便捷装配，分别引用 `core/config/` 与 `core/susan-home/`。Read、Write、Ls 等未拆分文件保持原路径。扩展名省略的导出字符串由 TypeScript 自动解析，无需改成显式 `/index`。

使用文件存在性检查确认以下 11 个旧文件均不存在，无旧路径转发壳：

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
```

## 有效行数

使用临时 pnpm dlx 缓存中的 ESLint `9.39.5` 与 `@typescript-eslint/parser` `8.70.0`，通过 `Linter.verify` 检查全部 74 个 `packages/harness/src/**/*.ts` 文件，无解析错误。以 `max-lines` 的 `max: 0`、`skipBlankLines: true`、`skipComments: true` 取得 ESLint 实际计数，再断言每个计数 ≤300，结果全部通过。未向仓库加入 ESLint 依赖或配置，符合 #146 的范围限制。

首次 CLI 尝试因 parser 无法从仓库解析而退出；改为从同一 dlx 缓存加载 ESLint 和 parser 后完成上述检查。该失败未计为通过。

| 文件（相对于 Harness src） | ESLint 有效行数 |
| --- | ---: |
| `core/edit/text-ops.ts` | 300 |
| `core/bash/shell.ts` | 299 |
| `core/grep/execute.ts` | 287 |
| `core/harness/harness.ts` | 276 |
| `core/find/execute.ts` | 272 |
| `assembly/index.ts` | 253 |

其余 68 个源文件均 ≤220 有效行。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @weiguangchao/susan-harness typecheck` | 通过 |
| `pnpm --filter @weiguangchao/susan-harness exec vitest run test/shared-contracts.test.ts` | 1 个测试文件、5 个测试通过 |
| `pnpm --filter @weiguangchao/susan-harness test` | 全量 23 个测试文件、321 个测试通过 |
| `SUSAN_SMOKE_KEEP_TEMP=1 pnpm --filter @weiguangchao/susan-harness package:smoke` | Core/Harness 构建及 Harness 包烟测通过 |

包烟测在仓库外安装原始 tarball，验证运行时及声明导出白名单、全部公开类型消费、deep import 拒绝、内部 API 不外泄，以及现有 consumer 行为。Harness tarball SHA-256：`d342b17f494715963fae0666fa73331a9fa653dd3c8a3b5b790c5b740c05a271`。

本机烟测产物保留在 `/var/folders/vl/__shcdp52djdnd4hc76s0cr00000gn/T/susan harness smoke-SmZeL6`，该临时目录不属于长期归档。

本次只新增验收记录，源码已满足 #154，无需修改行为或补充内部实现测试。未执行 Linux、Windows、TUI 真终端人工验收；本记录不代表完整产品 Release Gate。
