# cwd 是可见执行边界而非 sandbox

Built-in Tool Set 以 Session Header 中稳定的 Session cwd 解析相对路径。相对路径以该目录为基准，绝对路径按原值使用；cwd 外路径仍按 Yolo 执行。`bash` 在 Session cwd 中启动，但 command 可访问进程权限允许的其他路径。Read、Write 与 Edit 遵循文件系统的 symlink 语义，Grep、Find 与 Ls 的遍历行为由各 Tool 自身契约决定。

Session cwd 提供稳定的路径基准，不是 OS sandbox 或权限边界。TUI 可以标示 cwd 外目标，但该呈现不改变 Harness 的访问权限或执行结果。
