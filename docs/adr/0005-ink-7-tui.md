# Ink 7 作为 0.0.1 TUI 框架

susan 0.0.1 选择 Ink 7 而非 OpenTUI。OpenTUI 需要 Node 26.4 与 experimental FFI，和已定的 Node ≥ 22 冲突；Ink 7 在当前运行时上更稳定，React 模型也便于把输入、消息流、Tool 卡片与审批弹窗组合成清晰边界。取舍是 TUI 仍是 DOM-like abstraction，不做复杂主题、滚动回看或原生 full-screen 控件，只保证 0.0.1 的交互与状态呈现。
