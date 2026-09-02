# TUI 框架调研（Ink vs OpenTUI，2026）

调研日期：2026-09-02。一手来源：GitHub 仓库 / package.json / release notes、npm registry、opentui.com 官方文档。

## 结论

**维持 Ink 7 + React 19。** susan Notes 已定 Node ≥ 22、pnpm、tsup/tsdown 打 ESM 单文件、以 npm 包 `@weiguangchao/susan` 分发。Ink 7 的 `engines.node: ">=22"`、纯 JS ESM、无 native 二进制，正好落在这条约束里。

OpenTUI 0.5 非常活跃（调研前一天仍在发版），且被 OpenCode 用于生产，但 Node 路径要求 **Node.js 26.4.0 + ESM + `--experimental-ffi`**，另带 8 个平台 optional native 包。这与 v1 的 Node 下限和「单文件 ESM」分发冲突，不是 v1 选项。

`ink-testing-library` **不再跟上 Ink 7**，但 Notes 已定 v1 不测 TUI，不阻塞选型。

## 1. Ink

### 维护状态

- 仓库：https://github.com/vadimdemedes/ink （MIT）
- npm `latest`：**7.1.1**，发布时间 **2026-07-16**。https://www.npmjs.com/package/ink
- `master` 在 7.1.1 之后仍有提交：最后 push **2026-08-25**（例如 #994 改 clear 以保留 scrollback、#986 修无界 text cache、#979 修 dangling `staticNode`）。维护活着，只是 npm 还没切到这些 commit。
- v7.0.0 发布于 **2026-04-08**（sindresorhus）：强制 Node 22、React 19.2+。https://github.com/vadimdemedes/ink/releases/tag/v7.0.0

### React / Node / ESM

来自 `master` 的 `package.json`（与 7.1.1 一致）：https://raw.githubusercontent.com/vadimdemedes/ink/master/package.json

- `"type": "module"`；`exports` 指向 `./build/index.js` + `./build/index.d.ts`
- `engines.node`: `>=22`
- peer：`react >= 19.2.0`、`@types/react >= 19.2.0`（optional）
- 依赖 `react-reconciler ^0.33.0`、`yoga-layout ~3.2.1`（Yoga 走 npm 包，不是自研 native）

Node ≥ 22 下直接 `import {render, Box, Text} from "ink"` 即可。官方 example 用 `node --import=tsx`。susan 用 tsup/tsdown 打 ESM 单文件时，Ink 是纯 JS，没有 platform binary 要外置。

### 流式文本追加：性能与已知问题

官方推荐把「写完就不再变」的内容放进 `<Static items={...}>`：新 item 永久写到上方、不再重绘；改旧 item 不会触发重绘。

https://github.com/vadimdemedes/ink#static

`render()` 选项（README API）：

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `maxFps` | `30` | 限制重绘频率。官方原文：「prevent excessive re-rendering」 |
| `incrementalRendering` | `false` | 只重写变化的行，减 flicker |
| `alternateScreen` | — | v7 新增，进 alternate buffer（vim/less 式） |

https://github.com/vadimdemedes/ink （`maxFps` / `incrementalRendering`）

历史 flicker：[#359](https://github.com/vadimdemedes/ink/issues/359)（输出高于一屏时全量擦写会闪）。维护者在近期关闭，理由是已有 **incremental rendering**（只重绘变化行）和 **Synchronized Update Mode**（终端原子批量更新）。实现见 [#781](https://github.com/vadimdemedes/ink/pull/781)。未开 `incrementalRendering` 时仍是擦写整块动态区。

对 susan 的用法：已完成的消息 / Tool 结果进 `<Static>`；当前流式 token、输入框、审批弹窗留在可变树；打开 `incrementalRendering`。流式 token 仍受默认 30fps 节流——对聊天可读性够用，不是 OpenCode 那种全屏高刷。

### 组件测试：ink-testing-library

- 仓库：https://github.com/vadimdemedes/ink-testing-library
- npm **4.0.0**，发布 **2024-05-22**。https://www.npmjs.com/package/ink-testing-library
- 默认分支最后一次 commit：**2024-05-22**（`Fix CI`）。仓库 `pushed_at` 2024-06-28 来自未合并 PR。
- 其 `package.json`：`ink ^5.0.0`、`react ^18.3.1`、`engines.node >=18`。https://raw.githubusercontent.com/vadimdemedes/ink-testing-library/master/package.json
- [#29](https://github.com/vadimdemedes/ink-testing-library/issues/29)（2025-12-08，仍 open）：Ink v5 起 `useInput` 听内部 `input` 事件，不再听 stdin `data`；`stdin.write()` 测键盘失效。
- [#28](https://github.com/vadimdemedes/ink-testing-library/pull/28)（2025-06，未合并）：社区想升到 Ink 6 / React 19，维护者要求先在 Ink 侧修，没有落地。

**结论：ink-testing-library 对 Ink 7 实质上未维护。** 与 Notes「vitest 只测 Harness、不测 TUI」一致，v1 不要引入它。

## 2. OpenTUI

### 维护状态

- 仓库：https://github.com/anomalyco/opentui （MIT）；文档：https://opentui.com/docs
- npm：`@opentui/core@0.5.10`、`@opentui/react@0.5.10`，发布时间 **2026-09-01**。
- GitHub 最后 push **2026-09-01**；release `v0.5.10` 同日。仍是 0.x。
- README：「OpenCode uses OpenTUI in production for millions of users。」https://raw.githubusercontent.com/anomalyco/opentui/main/README.md

### React / Node / ESM

`@opentui/core` 的 `package.json`：https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/package.json

- `"type": "module"`；`engines` **只写** `"bun": ">=1.3.0"`（没有 `node` engines）
- 8 个 optional native 包：`@opentui/core-{darwin,linux,win32}-{x64,arm64}`，Linux 另有 musl 变体
- TypeScript 经 FFI 调 Zig core（core README 原文）

官方运行时表：https://opentui.com/docs/getting-started/runtime-support/

| Runtime | 要求 |
| --- | --- |
| Bun | ≥ 1.3.0 |
| Node.js | ≥ **26.4.0**，ESM，`--experimental-ffi` |

`@opentui/react` peer：`react >= 19.2.0`。同一页写明：**React 没有 dedicated Node.js CI lane**，Node 信心只覆盖 Core / Solid。

core README 同步写了 Node 26.4 + `--experimental-ffi`：https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/README.md

### 分发

susan 计划 tsup/tsdown 打 **ESM 单文件**。OpenTUI 的 native `.node` / 平台包、Tree-sitter worker、`OTUI_ASSET_ROOT` 不能压进一个 JS 文件。Node SEA 还要 `getNodeAssets()` 启动时解包。这与 v1 分发模型不合。

### 流式性能

官方没有给「高频文本追加」的量化数字。架构是 Zig 帧缓冲 + 命令式 renderable，适合增量更新。`@opentui/react` 仍走 React reconciler。OpenCode 用它，说明 agent 会话级吞吐在这条栈上被验证过——但那是 Bun + native，不是 Node 22 单文件。

### 测试

公开文档**有**头等测试 API（初稿写「没有帧断言」是错的）：

- `@opentui/core/testing`：`createTestRenderer()`，内存帧、`captureCharFrame()` / `captureSpans()`、mock 键盘鼠标。Bun 与 Node 都标 Supported。https://opentui.com/docs/core-concepts/testing/  https://opentui.com/docs/reference/api-index/
- `@opentui/react/test-utils`：`testRender()`，`act()` 挂载。https://opentui.com/docs/bindings/react/

测试基建比 ink-testing-library 强，但 Notes 已定 v1 不测 TUI，构不成换栈理由。

## 3. 其他 2026 年仍在动的 TS TUI

只列能核到一手仓库/npm 的；都不替代 Ink 做 susan v1。

| 包 | 一手状态 | 为何不是 v1 |
| --- | --- | --- |
| [Rezi](https://github.com/RtlZeroMemory/Rezi)（`@rezi-ui/*`） | 2026-02 起步；最新 `v0.1.0-beta.2`（2026-06-11）；C native 引擎 Zireael | 仍 beta；native 分发问题与 OpenTUI 同类 |
| [Glyph](https://github.com/semos-labs/glyph) | 2026-02 起步；`v0.2.10`（2026-03-04）；约 48 star | 体量与生态不够 |
| [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui) | npm 2026-05 仍在发；自称 differential rendering | 不是 React；生态远小于 Ink |
| `blessed` / `react-blessed` / `neo-blessed` | blessed 长期停更；react-blessed 文档停在 React 17 | 不适合新项目 |
| `@clack/prompts` | 维护中 | 一次性 prompt，不是持续 Session TUI |

## 4. 对照（susan v1 约束）

| 维度 | Ink 7.1.1 | OpenTUI 0.5.10 |
| --- | --- | --- |
| 维护 | 2026-07 npm；2026-08 仍有 master 提交 | 2026-09-01 发版；0.x |
| React | ≥ 19.2 | ≥ 19.2（`@opentui/react`） |
| Node | ≥ 22，纯 JS | ≥ 26.4 + `--experimental-ffi`；主路径是 Bun ≥ 1.3 |
| ESM 单文件 | 可以 | 不行（8 个 platform native + assets） |
| 流式追加 | `<Static>` + 可选 `incrementalRendering`；默认 30fps | Zig 帧缓冲；无官方量化；OpenCode 生产验证 |
| 测试 | ink-testing-library 停在 2024-05，Ink 5+ 键盘测坏 | `@opentui/core/testing` + `@opentui/react/test-utils` 头等 |
| 生产旁证 | Copilot CLI / Wrangler 等历史用户（生态大） | OpenCode（官方 README） |

## 5. 对后续票的含义

- **[原型：TUI 布局与交互（消息流、Tool 过程、审批弹窗）](https://github.com/weiguangchao/susan/issues/11)**：用 Ink 7 + React 19。已完成消息进 `<Static>`，当前流 / 输入 / 审批走可变树，打开 `incrementalRendering`。
- TUI 可测性：v1 不引入 ink-testing-library；会话与 Approval Policy 逻辑放在 Harness 里用 vitest 测。雾「TUI 的可测性策略」可毕业成独立决策票。
- 若将来把 Node 下限抬到 26 LTS 并接受 native 分发，再评估 OpenTUI；**不是 v1 路线**。
