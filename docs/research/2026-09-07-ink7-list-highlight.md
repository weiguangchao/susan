# Ink 7 下列表选中与子串高亮的约束

调研日期：2026-09-07。回答 [调研：Ink 7 下列表选中与子串高亮的约束](https://github.com/weiguangchao/susan/issues/66)。

一手来源：Ink `v7.1.1` 源码与 README（Susan 依赖 `ink@^7.1.1`）、npm `ink@7.1.1` 类型、ADR-0005、Susan 当前 TUI。不使用二手博客。

固定快照：

- Ink：[`vadimdemedes/ink@v7.1.1`](https://github.com/vadimdemedes/ink/tree/v7.1.1)（2026-07-16 npm latest，与 Susan `package.json` 一致）
- npm 类型：<https://unpkg.com/ink@7.1.1/build/index.d.ts>、<https://unpkg.com/ink@7.1.1/build/components/Text.d.ts>
- wrap / truncate 实现依赖：[`wrap-ansi`](https://github.com/chalk/wrap-ansi)（Ink 声明 `^10.0.0`）、[`cli-truncate`](https://github.com/sindresorhus/cli-truncate)（`^6.0.0`）

Susan TUI 事实分两层：本 branch 对齐 `origin/master` 的 `src/ui/session-picker.tsx` / `src/ui/tui.tsx`；CommandHintLine、model picker、input layout、`prototype/tui-prototype.tsx` 来自 2026-09-07 用户 worktree（当时相对 `origin/master` 未提交）。调研只读这些文件，不改用户 dirty tree。

## 结论

在坚持 [ADR-0005](../adr/0005-ink-7-tui.md)（Ink 7、无复杂主题、无原生 full-screen 控件）的前提下，Ink 7 **能稳定表达** Slash Command Menu 需要的三件事：`Box flexDirection="column"` 多行候选、应用层选中行（前缀标记 / 整行 `color` / `inverse` / 定宽 `Box backgroundColor`）、以及**同一命令名内的子串高亮**（把名字切成 before / match / after，嵌套 `<Text>` 上色或加粗）。

Ink **没有**列表、下拉、滚动视口或 overlay 原语。`ink@7.1.1` 的公开导出只有 `Box`、`Text`、`Static`、`Transform`、`Newline`、`Spacer` 和若干 hooks；README 里的 `ink-select-input` / `ink-scroll-list` 是生态包，不是框架能力，也不符合 ADR-0005。

稳定做法是：一列一行一个候选；选中态用 `▸`/`›` + `color`/`bold`（Susan session picker 已如此）；匹配段放进**同一个父 `<Text wrap="truncate-end">`** 的嵌套子 `<Text>`。不要用默认 `wrap="wrap"` 当「一行」；不要把名字的三段做成 `Box` 的兄弟节点（Yoga 会各自量宽、各自折行）。

Susan 已经可复用：session picker 的垂直选中行、CommandHintLine 的嵌套 `<Text>` 与 `slashCommands` 目录、input layout 的列宽与 `truncate-end`。还缺的是「在命令名内部切子串」——现有 hint / prototype 都是整词 `startsWith` 高亮，不是子串高亮。

## 1. Ink 7 能稳定表达什么

### 1.1 嵌套 `<Text>` 就是中段上色 / 加粗

官方约定：`<Text>` 只接受文本节点和嵌套 `<Text>`，不能把 `<Box>` 放进 `<Text>`。来源：[Ink README · Text](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#text)。

`Text` 的样式面（npm 类型与源码一致）：`color`、`backgroundColor`、`dimColor`、`bold`、`italic`、`underline`、`strikethrough`、`inverse`、`wrap`。`color` / `backgroundColor` 走 Chalk（具名色、`#hex`、`rgb()`）。来源：[Text.tsx](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/components/Text.tsx)、[Text.d.ts](https://unpkg.com/ink@7.1.1/build/components/Text.d.ts)。

渲染时，父 `ink-text` 先 `squashTextNodes`：递归拼接子文本，并对每个子节点调用它自己的 `internal_transform`（也就是该层的 chalk 样式），最后 `sanitizeAnsi`。来源：[squash-text-nodes.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/squash-text-nodes.ts)。因此下面这种切分是框架支持的内联样式，不是 hack：

```tsx
<Text wrap="truncate-end">
  {selected ? "› " : "  "}
  <Text>{before}</Text>
  <Text color="cyanBright" bold>{match}</Text>
  <Text>{after}</Text>
  <Text dimColor> {label}</Text>
</Text>
```

匹配段可以同时 `color` + `bold` + `underline`；选中行可以再给父节点加 `inverse`，或把整行包进定宽 `Box backgroundColor`。

### 1.2 多行列表 = `Box` column，不是控件

README 用 `flexDirection="column"` 把多个 `<Text>` 叠成行。来源：[Ink README · flexDirection](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#flexdirection)。

`ink@7.1.1` 没有 `Select` / `List` / `Menu`。公开导出见 [index.d.ts](https://unpkg.com/ink@7.1.1/build/index.d.ts)。键盘由 `useInput` 提供 `upArrow` / `downArrow` / `return` / `escape`（以及 `pageUp` / `pageDown`）。来源：[use-input.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/hooks/use-input.ts)。选中下标是应用 state。

### 1.3 选中行的四种稳定标记

| 手段 | 机制 | 适合菜单的条件 |
| --- | --- | --- |
| 前缀 glyph（`▸` / `›`） | 普通文本 | 最稳；Susan session picker 已用 |
| 整行 `color` / `bold` | 父 `<Text>` 样式 | 稳；不填满行宽 |
| `inverse` | `chalk.inverse`，交换该段 fg/bg | 稳在「这段文字」上；外观随终端默认底色变 |
| `Box backgroundColor` | 填满 **Box 区域**，子 `<Text>` 默认继承 | 要「整条选中条」必须给行明确 `width`（数字或 `%`）；收缩到内容宽时背景只盖住文字 |

`Box backgroundColor` 填整个 box，并被子 `Text` 继承，除非子节点自己设 `backgroundColor`。来源：[Ink README · Box backgroundColor](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#backgroundcolor-1)。

ADR-0005 排除复杂主题，因此菜单应停在 glyph + 一两种已有色（Susan 已用 `cyan` / `cyanBright` + `bold`），不要引入调色板或第三方 select 皮肤。

### 1.4 wrap / truncate 可以保住嵌套样式

父 `ink-text` 在 squash 之后量宽；超过 Yoga `maxWidth` 才按 `style.textWrap`（默认 `wrap`）调用 `wrapText`。来源：[render-node-to-output.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts)、[wrap-text.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/wrap-text.ts)。

- `wrap` / `hard` → `wrap-ansi`（**ANSI 感知**换行）
- `truncate*` → `cli-truncate`（**ANSI 感知**，并处理 fullwidth / surrogate）

`wrap-ansi` 的职责就是「带 ANSI 的字符串按列宽折行」。来源：[wrap-ansi README](https://github.com/chalk/wrap-ansi/blob/main/readme.md)。`cli-truncate` 对带 chalk 的串截断后仍保留 escape，并支持东亚全宽字符。来源：[cli-truncate README](https://github.com/sindresorhus/cli-truncate/blob/main/readme.md)。

因此：**子串高亮与截断可以同时成立**，前提是 `wrap="truncate-end"` 设在**包住整行（含嵌套高亮）的父 Text** 上。量宽走 `widest-line` / `string-width`，中文 label 按全宽计。

`#867`（空串变非空时嵌套 Text 错行）已由 `#879`（2026-02-16）修掉，并进入 `v7.1.1`。来源：[issue 867](https://github.com/vadimdemedes/ink/issues/867)、[PR 879](https://github.com/vadimdemedes/ink/pull/879)。Susan 钉在 7.1.1，不必为这个回归避开嵌套 Text；仍建议 before/match/after 三个子节点稳定挂着，不要在 `""` 与缺省 children 之间来回卸挂。

## 2. 做不到 / 不要指望框架保证的

1. **没有原生菜单、下拉、滚动列表、full-screen overlay。** README「Useful Components」列出的 `ink-select-input`、`ink-scroll-list`、`ink-virtual-list`、`ink-scroll-view` 是第三方包。来源：[Ink README · Useful Components](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#useful-components)。ADR-0005 已排除原生 full-screen 控件与复杂主题；菜单必须是现有 column 布局里多出来的几行 `Box`/`Text`。
2. **没有内置「搜索高亮」。** 框架不会扫描字符串并上色；应用自己切 match。`Transform` 拿到的已是带 ANSI 的行，且「不得改变输出尺寸」。来源：[Ink README · Transform](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#transform)。
3. **默认 `wrap="wrap"` 会把「一行候选」变成多行。** README 示例：`width={7}` 时 `Hello World` → `Hello\nWorld`。来源：[Ink README · wrap](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#wrap)。列表行应显式 `truncate-end`（Susan Tool 行 / Input 行已这样做）。
4. **`Box` 里并排的多个 `<Text>` 不是一段 inline run。** 父级是 `ink-box` 时，每个 Text 是独立 Yoga 节点、自带坐标。来源：[render-node-to-output.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts) 文件头注释。命令名的 before/match/after 若做成 Box 兄弟，折行和截断会在节点边界断开。
5. **不能把 `Box` 塞进命令名当「高亮芯片」。** Text 只许嵌套 Text。来源：README Text 注记。
6. **`overflow` 默认 `visible`，`hidden` 只裁剪、不滚动。** 来源：[styles.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/styles.ts)（`overflow` 默认值注释）、[render-node-to-output.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/render-node-to-output.ts)（clip）。候选多于可视行数时，应用自己 slice 窗口；Ink 不提供 scrollback 控件（ADR-0005 也不做滚动回看）。当前目录只有 `/exit`、`/new`、`/model` 三行，通常不必做窗口。
7. **`inverse` / `underline` 是 SGR，不是布局。** 终端对 underline 的可见度、inverse 与默认背景的对比都不由 Ink 保证。`inverse` 只作用于该 Text 的字形，不会自动铺满整行。
8. **整行背景条需要显式宽度。** 未设 `width` 的 Box 收缩到内容；`backgroundColor` 不会变成终端宽的选中条。`width` / `height` 可用数字或相对父级的百分比。来源：[styles.ts](https://github.com/vadimdemedes/ink/blob/v7.1.1/src/styles.ts) `width` / `height`。
9. **Ink 的 wrap 写入硬 `\n`。** 复制/终端 reflow 会当成硬换行；维护者认为不能小补丁改掉。来源：[issue 883](https://github.com/vadimdemedes/ink/issues/883)。对短命令名 + `truncate-end` 不是阻塞，但不要让菜单行走默认 wrap 再指望「软折行」。
10. **百分比 `minWidth` / `maxWidth` 仍受 Yoga 限制。** `styles.ts` 写明百分比尚未支持（facebook/yoga#872）。行宽用数字列宽或 `%` 的 `width`，不要用 `%` `maxWidth` 当截断上限。

## 3. Susan 现有 TUI 已用哪些可复用能力

| 能力 | 现在怎么用 | 对 Menu 能不能复用 |
| --- | --- | --- |
| `slashCommands` 目录 | `state.ts`：`/exit`、`/new`、`/model` + label + intent；`/clear` 是 `/new` 的隐藏别名，不在数组里 | 候选数据源；菜单是否露出 `/clear` 不在本票 |
| 嵌套 `<Text>` 整词高亮 | **用户 worktree** `CommandHintLine`：`command.name.startsWith(input)` 时整段 `cyanBright` + `bold`，label / 分隔符 `dimColor` | 复用嵌套 Text 与色；**不是**子串高亮 |
| 水平 hint 轨 | CommandHintLine 是默认 `row` 的一排兄弟 Text，不是 column 列表 | 空闲 hint 的去留是地图上的另一决策；布局不能当 Menu |
| 垂直列表 + 选中行 | `session-picker.tsx`（master 已有）：column `map`，选中行 `▸` + `color="cyan"`；`useInput` 的 ↑/↓、Enter、Esc | **最接近的列表/选中模板**；仍是整行变色，无子串 |
| model picker | **用户 worktree** `model-picker.tsx`：圆角边框 inspector，当前 provider 一行 `cyan`，不是候选列表 | 只复用边框 / 底栏快捷键文案；不要当 Menu 列表 |
| 一行截断 | Tool 行、Input 行 `wrap="truncate-end"`；主栏 / 输入框 `overflow="hidden"` | 菜单行应同样截断，避免默认 wrap 拆行 |
| 列宽与 grapheme | **用户 worktree** `input-layout.ts`：`string-width` + `Intl.Segmenter`，按 `stdout.columns` 算内容宽 | 测 80 列预算；不负责高亮 |
| prototype 变体 B | **用户 worktree** `prototype/tui-prototype.tsx`：column + `›` + 名字 `cyanBright` + label `bold` | 视觉草稿；仍是整词，且标注 PROTOTYPE ONLY |
| 输入键盘 | TUI / session picker 已用 `useInput` | 方向键 / Enter / Esc 已在栈内 |

`origin/master` 的空闲行只是 `<Text dimColor>空闲</Text>`，没有 CommandHintLine、没有 model picker、没有 `input-layout.ts`。上面「当前 TUI」以用户 worktree 为准。

CommandHintLine 的匹配谓词是前缀、作用域是**整个** `command.name`，测试只断言 idle 文案，不断言高亮。来源：用户 worktree `src/ui/tui.tsx`、`test/tui-input.test.tsx`。

## 4. 对 Slash Command Menu 的含义

地图要的「字典序、关键字匹配、匹配段高亮、方向键、回车、ESC」在 Ink 7 里都可以用现有原语做，不必换框架、也不必加 select/scroll 包。

建议契约（本票只约束表达，不写实现规格）：

- 容器：`Box flexDirection="column"`，插在现有输入区附近，而不是 alternate screen / overlay。
- 每一行：一个父 `<Text wrap="truncate-end">`（或定宽 `Box` + 该 Text）。
- 选中：`›`/`▸` + 已有 `cyan`/`cyanBright`/`bold`；若要整行底色，给行 `width`（例如 `columns`）。
- 匹配段：应用切分命令名，嵌套 `<Text>` 上色/加粗；不要 Box 兄弟、不要默认 wrap。
- 三个 Slash Command 不必做滚动窗口；真要截断行数，应用 slice，不要引入 scroll 控件。

空闲 CommandHintLine 与 Menu 的关系不在本票范围。
