# Bash Tool 使用 one-shot shell 并按平台清理进程树

Susan 的 Bash Tool 为每次调用启动一个无 PTY、无持久会话、stdin 不参与交互的 one-shot shell。Unix 优先使用 `/bin/bash` 或 PATH 中的 `bash`，找不到时回退到 `sh`；Windows 使用可找到的 Git Bash、Cygwin、MSYS2 等 Bash。普通 shell 以 `-c` 接收 command，旧 WSL `bash.exe` 通过 stdin 接收 command。

Tool 继承进程环境并在 Session cwd 中运行。取消或超时时，POSIX 以 `SIGKILL` 终止受管理 process group，失败时再终止直接子进程；Windows 使用 `taskkill /T /F` 清理进程树。Windows 找不到 Bash 时返回 capability failure。该保证不引入 PTY、持久 shell 或 native Job Object helper。
