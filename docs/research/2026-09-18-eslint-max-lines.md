# eslint `max-lines` 在 TypeScript / TSX 上的计数规则

> 日期：2026-09-18
> 范围：回答 [eslint max-lines 在 TypeScript/TSX 上的计数规则](https://github.com/weiguangchao/susan/issues/132)。只核验 ESLint 官方文档与 `max-lines` 实现、typescript-eslint 如何把 TypeScript 注释交给该规则，以及本仓库 `packages/tui/src`、`packages/harness/src` 在该规则下的超标文件。不接入 eslint、不改业务代码。
> 证据快照：ESLint **v10.10.0**（[`3f20a57`](https://github.com/eslint/eslint/commit/3f20a57c6293371b6193d3fb6746c2b7b2ac2689)）、typescript-eslint **v8.70.0**（[`7ee7608`](https://github.com/typescript-eslint/typescript-eslint/commit/7ee76085c22e923c0036b8e0733a3ca7dfd82b60)）、ts-api-utils **v2.5.0**。本仓库测量 HEAD：[`6b493ac`](https://github.com/weiguangchao/susan/commit/6b493acf298bb6618c46722eabe88858c6bbf02a)。事实取自上述源码 / 官方文档；超标清单用临时 `npx` 安装的 eslint 10.10.0 + typescript-eslint 8.70.0 对源文件跑 `max-lines`，未写入本仓库依赖。

地图 [#131](https://github.com/weiguangchao/susan/issues/131) 已决定日后 ADR 用 `max: 300` 且 `skipBlankLines` / `skipComments` 为 true；本文只把这条决定翻译成规则实现语义与当前超标名单。测试目录不在范围。

## 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | TS / TSX 怎么计数？ | **与 JS 同一套规则**。`max-lines` 是 ESLint 核心规则，按 `sourceCode.lines` 数行，按 parser 提供的 `comments` 跳注释。TS/TSX 必须换 `@typescript-eslint/parser`（Espree 解析不了类型语法）；不需要 type-aware lint。类型、interface、泛型、JSX 元素都当代码行 |
| 2 | `max: 300` 是否含等于 300？ | **含。300 行通过，301 行报错。** 实现是 `lines.length > max`，报错文案为 `Maximum allowed is 300` |
| 3 | `skipBlankLines` 跳过什么？ | 去掉文件末尾因换行多出来的空行之后，`line.trim() === ""` 的行。纯空格 / Tab 算空行；空行在块注释内部则属于注释行，不走这条 |
| 4 | `skipComments` 跳过什么？ | **整行都是注释、同一行没有非注释 token 的行。** JSDoc、`/* */` 块注释、`//`、文件头 license、`///` triple-slash、`// @ts-ignore` 都是 `Block`/`Line`，整行可跳。行尾 `code; // x` 或 `code; /* x */` **不跳**。JSX `{/* */}` 是夹在 `{` `}` 之间的 Block 注释：只有中间纯注释行可跳，带花括号的那一行仍计数 |
| 5 | 日后 ADR 应写入的 rule JSON | 见下节。不要写成 `"max-lines": ["error", 300]`，那种形式**不会**跳空行和注释 |
| 6 | 当前超标文件 | TUI 3 个、Harness 10 个。`model-picker.ts` 恰好 300，**不算超标** |

日后 ADR 应锁定的规则片段（eslintrc / flat config 的 `rules` 值相同）：

```json
{
  "max-lines": ["error", { "max": 300, "skipBlankLines": true, "skipComments": true }]
}
```

当前超标（counted > 300；括号内为物理行 / 去掉的空行 / 去掉的整行注释）：

| 文件 | counted | 物理行 | skipBlank | skipComments |
|---|---:|---:|---:|---:|
| `packages/tui/src/ui/state.ts` | 1165 | 1216 | 49 | 2 |
| `packages/tui/src/ui/tui.tsx` | 1155 | 1226 | 62 | 9 |
| `packages/tui/src/ui/tool-ledger.ts` | 500 | 534 | 34 | 0 |
| `packages/harness/src/core/harness.ts` | 1032 | 1082 | 49 | 1 |
| `packages/harness/src/core/session.ts` | 854 | 920 | 64 | 2 |
| `packages/harness/src/adapters/openai-completion.ts` | 769 | 874 | 104 | 1 |
| `packages/harness/src/core/config.ts` | 594 | 665 | 71 | 0 |
| `packages/harness/src/core/bash.ts` | 492 | 537 | 41 | 4 |
| `packages/harness/src/core/edit-diff.ts` | 439 | 566 | 59 | 68 |
| `packages/harness/src/core/grep.ts` | 405 | 439 | 28 | 6 |
| `packages/harness/src/assembly.ts` | 373 | 382 | 8 | 1 |
| `packages/harness/src/core/find.ts` | 350 | 400 | 33 | 17 |
| `packages/harness/src/core/tools-manager.ts` | 349 | 410 | 55 | 6 |

临界未超标：`packages/tui/src/core/model-picker.ts` counted **300**（物理 318）；`packages/tui/src/ui/input-layout.ts` counted **281**（物理 313）。

## 一、计数算法：先切行，再可选地丢掉空行 / 整行注释，最后 `>` 比较

官方文档：[max-lines](https://eslint.org/docs/latest/rules/max-lines)。选项是数字或对象：

- `"max"`（默认 **300**）是文件最大行数
- `"skipBlankLines": true` 忽略纯空白行
- `"skipComments": true` 忽略只包含注释的行

文档还写：文件以换行结束时，编辑器常多显示一个空行；**本规则不计入那个额外空行**。

实现（[`lib/rules/max-lines.js`](https://github.com/eslint/eslint/blob/v10.10.0/lib/rules/max-lines.js) @ v10.10.0）：

1. `sourceCode.lines` 按 ECMA-262 换行符切开（`\r\n` / `\r` / `\n` / `\u2028` / `\u2029`）。见 [`source-code.js` 把文本切进 `this.lines`](https://github.com/eslint/eslint/blob/v10.10.0/lib/languages/js/source-code/source-code.js) 与 [`lineBreakPattern`](https://github.com/eslint/eslint/blob/v10.10.0/lib/shared/ast-utils.js)。
2. 若多于一行且最后一行文本为 `""`（文件以换行结束），`pop()` 掉。这就是文档说的「不计入那个额外空行」。
3. `skipBlankLines === true` 时丢掉 `text.trim() === ""` 的行。
4. `skipComments === true` 时，对 `sourceCode.getAllComments()` 的每个注释求出「同一行没有非注释 token」的行号，再从计数里滤掉。
5. **`if (lines.length > max)` 才 report**。相等不报。报错：`File has too many lines ({{actual}}). Maximum allowed is {{max}}.`

`max` 默认 300：`let max = 300`，`defaultOptions: [300]`。对象选项若省略 `max`，仍是 300。`skipComments` / `skipBlankLines` 没有 schema default，只有选项对象上的真值才启用（[`max-lines.js` L86-L87](https://github.com/eslint/eslint/blob/v10.10.0/lib/rules/max-lines.js#L86-L87)）。

官方测试把 `"AAAAAAAA\n".repeat(301).trim()` 配 `options: [{}]`（即默认 max 300）标为非法，`actual: 301`（[`tests/lib/rules/max-lines.js` L217-L228](https://github.com/eslint/eslint/blob/v10.10.0/tests/lib/rules/max-lines.js#L217-L228)）。用 eslint 10.10.0 复现：300 行代码通过，301 行报 `Maximum allowed is 300`。

因此 **`max: 300` 含等于 300**。

## 二、TypeScript / TSX：换 parser，不换规则

`max-lines` 不认识 TypeScript。它只读 ESLint `SourceCode` 的行数组和注释数组。TS/TSX 要能 parse，必须用 typescript-eslint 的 parser；官方说明 Espree 无法解析 `: number` 这类类型语法（[`@typescript-eslint/parser` 文档](https://github.com/typescript-eslint/typescript-eslint/blob/v8.70.0/docs/packages/Parser.mdx)）。`max-lines` 不读类型信息，不必开 `project` / `projectService`。

注释从 TypeScript scanner 的 trivia 转成 ESTree：

```ts
// packages/typescript-estree/src/convert-comments.ts @ v8.70.0
kind === ts.SyntaxKind.SingleLineCommentTrivia
  ? AST_TOKEN_TYPES.Line
  : AST_TOKEN_TYPES.Block
```

来源：[`convert-comments.ts`](https://github.com/typescript-eslint/typescript-eslint/blob/v8.70.0/packages/typescript-estree/src/convert-comments.ts)。`iterateComments` 遍历每个 token 的 leading / trailing comment range（[`ts-api-utils` `src/comments.ts` @ v2.5.0](https://github.com/typescript-eslint/ts-api-utils/blob/v2.5.0/src/comments.ts)）。结果只有两种 token 类型：**Line** 与 **Block**。没有单独的 JSDoc / JSXComment / License 节点。

因此：

| 源码形态 | parser 交给 `max-lines` 的类型 | `skipComments: true` |
|---|---|---|
| `// line`、`// @ts-ignore`、`/// <reference ...>` | `Line` | 整行无代码则跳过 |
| `/* block */`、文件头 license、`/** JSDoc */` | `Block` | 注释覆盖且无代码的行跳过 |
| JSX `{/* comment */}` | 仍是 `Block`，但同一行还有 `{` / `}` token | 见下一节 |
| `interface` / `type` / 泛型 / JSX 元素 | 代码 token | 计数 |
| `#!/usr/bin/env node` | parser 先当 `Line`，ESLint `SourceCode` 再改成 `Shebang`（[`source-code.js` L370-L378](https://github.com/eslint/eslint/blob/v10.10.0/lib/languages/js/source-code/source-code.js#L370-L378)） | 仍在 `getAllComments()` 里；整行 shebang 会被跳过。本仓库 `packages/tui/src/cli.ts` 即此情况 |

`skipComments` 判断「邻接 token 是不是注释」时只认 `Block` 与 `Line`，不含 `Shebang`（[`isCommentNodeType`](https://github.com/eslint/eslint/blob/v10.10.0/lib/rules/max-lines.js#L96-L98)）。对单独一行的 shebang 没有影响：它自己的 `loc` 仍被算进可跳过行。

## 三、`skipComments` 的精确含义：整行注释，不是「行里有注释」

`getLinesWithoutCode`（[`max-lines.js` L105-L136](https://github.com/eslint/eslint/blob/v10.10.0/lib/rules/max-lines.js#L105-L136)）：

- 起点 / 终点先取注释的 `loc.start.line` / `loc.end.line`
- 若注释**之前**最近的非注释 token 与注释同一行，起点 +1
- 若注释**之后**最近的非注释 token 与注释同一行，终点 -1
- 起点 > 终点则该注释不贡献任何可跳过行（整段注释都跟代码共行）

官方测试已固定这些边界（[`tests/lib/rules/max-lines.js`](https://github.com/eslint/eslint/blob/v10.10.0/tests/lib/rules/max-lines.js)）：

- 多行 `/* ... */`、夹在代码中间的跨行 inline 注释：只有中间纯注释行跳过
- `var x; // inline` 整行计数
- 空白行在 `skipComments` 单独开启时仍计数；两个选项一起开才同时丢掉

用 eslint 10.10.0 + typescript-eslint 8.70.0 对 TS/TSX 复现（均 `max: 2, skipComments: true`，除非另注）：

- 文件头 `/* Copyright ... */`、`/** JSDoc */`、`//`、`/// <reference types="node" />`、`// @ts-ignore`、shebang：整段可跳，剩下两行代码通过
- `const a = 1; // inline` 三行代码：报 3 > 2
- 单行 JSX `    {/* jsx comment */}`：注释 token 的 loc 在 `{` 与 `}` 之间，该行有花括号，**计数**。`max: 5` 报 6；`max: 6` 通过
- 多行 JSX：

  ```tsx
  {/*
    inner jsx
    more
  */}
  ```

  中间两行跳过，`{/*` 与 `*/}` 两行仍计数

本仓库真实 TSX 例子，`packages/tui/src/ui/tui.tsx` L405-L407：

```tsx
{/* Keep natural content height: shrinking multiline text can overlap
    reasoning and answers. Fill short frames from the top; clip only
    the beginning of overflowing live content to show its latest rows. */}
```

parser 给出一条 `Block` 注释，loc 从 L405 col 11 到 L407 col 83（不含两侧花括号）。`skipComments` 只丢掉中间 L406；L405 / L407 因 `{` `}` 仍计入。该文件 skipComments = 9 = 8 条整行 `//` + 这 1 行 JSX 中间行。

块注释里的空行属于注释 `loc` 范围，按注释跳，不按空白跳。`skipBlankLines` 先于 `skipComments` 执行，顺序不影响这类行的去留。

## 四、ADR 应写入的 JSON，以及不要写成什么

地图要求：max 300，且 `skipBlankLines` 与 `skipComments` 为 true。与 schema 对齐的最小、无歧义写法：

```json
{
  "max-lines": ["error", { "max": 300, "skipBlankLines": true, "skipComments": true }]
}
```

不要用这些等价看起来像、语义不同的形式：

| 写法 | 实际效果 |
|---|---|
| `"max-lines": "error"` 或 `["error", 300]` | max 300，**计数空行和注释** |
| `["error", { "skipBlankLines": true, "skipComments": true }]` | 实现里 `max` 仍默认 300，但 ADR 应把 `max` 写死，避免以后 `defaultOptions` 合并方式变化 |
| `["error", 300, { "skipComments": true }]` | schema `oneOf` 只允许**一项**（整数或对象）。这是非法配置（见 [eslint#15779](https://github.com/eslint/eslint/issues/15779)，works as intended） |

Parser、flat vs eslintrc、CI、是否覆盖 `test/` 由地图列为尚未指定，本文不锁。实施时 TS/TSX 仍需 `@typescript-eslint/parser`（或 `typescript-eslint` 的 parser 导出），`parserOptions.ecmaFeatures.jsx: true` 才能解析 `.tsx`。`max-lines` 本身无 TS 专用选项。

## 五、测量方法与超标名单

仓库此刻没有 eslint 配置。测量在 `/tmp` 安装 eslint@10.10.0、typescript-eslint@8.70.0、typescript@5.9.2，用 flat config：

- parser：`typescript-eslint` parser，`ecmaFeatures.jsx = true`，无 `project`
- 规则：上一节的 JSON
- 对 `packages/tui/src`、`packages/harness/src` 下每个 `.ts` / `.tsx` 调 `lintText`（`lintFiles` 在临时 cwd 外会因 `files` glob 匹配不到而漏报）

规则报错里的 `actual` 与按源码重放的计数一致。物理行是去掉末尾换行后的行数，约等于 `wc -l`，**不是** `max-lines` 的 counted。

超标文件即结论表（counted > 300）。其余 `packages/tui/src`、`packages/harness/src` 源文件均 ≤300。`packages/core` 不在范围。

未在源码里看到 SPDX / Copyright 文件头；Harness 有大量 JSDoc Block（`edit-diff.ts` 因此 skipComments = 68）。TUI 几乎没有整行注释，所以 `state.ts` / `tool-ledger.ts` 的 counted 非常接近物理行减空行。
