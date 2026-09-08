# Ink 7 作为 0.0.1 TUI 框架

susan 0.0.1 选择 Ink 7 而非 OpenTUI。OpenTUI 需要 Node 26.4 与 experimental FFI，和已定的 Node ≥ 22 冲突；Ink 7 在当前运行时上更稳定，React 模型也便于把输入、消息流、Tool 执行账本、模型选择与 Session 恢复状态组合成清晰边界。取舍是 TUI 仍是 DOM-like abstraction，不做复杂主题、滚动回看或原生 full-screen 控件，只保证 0.0.1 的交互与状态呈现。

## 2026-09-07：正文后的输入区与状态栏

清屏后，活动区按终端高度铺满，用弹性空白把输入框与状态栏钉在最后一行。活动区高度会告知 Ink 作为视口高度，避免它给不足整屏的帧多写一个尾随换行；光标后缀按 fullscreen 校正。首次提交把用户消息写入 Static 后，活动区缩短相应行数，因此消息出现在上方、输入区仍固定在底部，不会整块跳到顶部消息下面。

流式输出占用输入区上方的弹性空白；回复完成后，长正文进入 Static，活动区收成页脚，不在回复末尾追加整屏空白。输入框与状态栏随终端原生 scrollback 一起滚动，不使用 alternate screen，也不接管鼠标滚轮。完成消息与 Tool Batch 使用 Static 序列保留。输入法光标按活动区高度定位。

TUI 使用终端主屏幕。Session Transcript 的持久化规则不变。
