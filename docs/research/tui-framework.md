# TUI 框架调研（Ink vs OpenTUI，2026）

调研日期：2026-09-02。一手来源：npm registry、GitHub README / package.json、官方文档。

## 结论

**维持 Ink。** susan 的 Notes 已定 Node ≥ 22、以 npm 包分发给个人使用；Ink 7 正好是这条约束下的成熟选择。OpenTUI 0.5 活跃且被 OpenCode 用于生产，但运行时要求是 Bun 1.3 或 **Node.js 26.4.0 + `--experimental-ffi`**，与 v1 的 Node 下限冲突。

风险：`ink-testing-library@4.0.0` 仍停留在 2024-05 对 Ink 5 的测试集，Ink 7 的 30fps 输入节流会让键盘测试不稳定。Notes 已定 v1 不测 TUI，这条风险不阻塞选型。

## 1. Ink

- 最新稳定版 **7.1.1**，npm `latest`；`type: "module"`（ESM）；`engines.node: ">=22"`；peer：`react >= 19.2.0`、`@types/react >= 19.2.0`。
  - https://www.npmjs.com/package/ink
- 发布时间：`time.modified` **2026-07-16**。
  - `npm view ink time.modified`
- README 明确写「This readme documents the upcoming version of Ink. For the latest stable release, see Ink on npm」，但 npm 的 `latest` 已是 7.1.1。
  - https://github.com/vadimdemedes/ink
- 流式追加：官方推荐 `<Static items={...}>`，新 item 永久写到上方、不再重绘；旧 item 的改动会被忽略。
  - https://github.com/vadimdemedes/ink#static
- 渲染节流：`render()` 选项 `maxFps` 默认 30；`incrementalRendering` 默认 false，打开后只更新变化的行，用来减 flicker。
  - https://github.com/vadimdemedes/ink （API → render options）
- 测试：README 仍指向 [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)。该包 npm **4.0.0**，`time.modified` **2024-05-22**，devDependency 是 `ink ^5.0.0`，peer 只有 `@types/react >=18`。
  - https://www.npmjs.com/package/ink-testing-library
  - https://raw.githubusercontent.com/vadimdemedes/ink-testing-library/master/package.json
- 第三方证据（非选型依据，仅说明测试缺口）：Qwen Code 在升到 Ink 7 后因 30fps throttle 跳过了 ink-testing-library 的键盘用例。
  - https://github.com/QwenLM/qwen-code/issues/4036

## 2. OpenTUI

- 仓库：https://github.com/anomalyco/opentui ；站点：https://opentui.com
- npm：`@opentui/core@0.5.10`、`@opentui/react@0.5.10`。core 的 `time.modified` **2026-09-01**（调研前一天仍在发版）。
  - https://www.npmjs.com/package/@opentui/core
- 描述：TypeScript 包 + 内部 Zig 实现，经 FFI 调用。
  - https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/README.md
- **运行时**：Bun ≥ 1.3.0，或 Node.js ≥ **26.4.0** + ESM + `--experimental-ffi`。Quickstart 用 `bun add` / `bun index.ts`。
  - https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/README.md
  - https://opentui.com/docs/getting-started/quickstart
- 绑定：`@opentui/react`（peer `react >= 19.2.0`）、`@opentui/solid`。
  - https://raw.githubusercontent.com/anomalyco/opentui/main/README.md
- 文档：opentui.com/docs 有 Quickstart、React/Solid、lifecycle。开发文档默认 Bun。
- 生产背书：README 写「OpenCode uses OpenTUI in production for millions of users」。
  - https://raw.githubusercontent.com/anomalyco/opentui/main/README.md
- 测试：仓库用 `bun run test` + native Zig tests；公开文档没有类似 ink-testing-library 的「渲染帧断言」API。
- 流式性能：官方没有对「高频文本追加」给出量化数字。Core 是命令式 renderable + 帧调度，理论上适合增量更新，但 susan 若用 `@opentui/react` 仍会走 React 协调。

## 3. 其他仍在维护的 TS TUI（一行）

- `@mariozechner/pi-tui@0.73.1`（2026-05-07）：「differential rendering」的 TS TUI，npm 仍在发。https://www.npmjs.com/package/@mariozechner/pi-tui
- `terminal-kit`、`blessed` / `neo-blessed`、`@clack/prompts`：存在但不适合做持续 agent 会话界面（blessed 生态停滞；clack 是一次性 prompt）。

## 4. 建议与风险

维持 **Ink 7 + React 19**，bundler 打 ESM 单文件即可。具体用法：

- 已完成的消息进 `<Static>`，当前流式 token / 输入框 / 审批弹窗走可变树。
- 打开 `incrementalRendering` 观察 flicker；必要时下调 `maxFps`。
- 不把 ink-testing-library 当作 v1 测试基建。

不选 OpenTUI 的硬原因：Node 26.4 + experimental FFI 超出 Notes 的 Node ≥ 22；npm 安装的用户无法默认跑起来。若将来把下限抬到 Node 26 LTS，可以再评估切换。
