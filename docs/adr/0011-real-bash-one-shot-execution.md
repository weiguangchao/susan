# Bash Tool 固定使用真实 Bash 并接受分层进程树清理保证

Susan 的 Bash Tool 在三平台都只启动探测通过的真实 Bash，以 `--noprofile --norc -c` 执行 one-shot command，不用宿主默认 shell、PowerShell、CMD 或 WSL gateway 冒充 Bash；缺少 Bash 是明确的 capability failure。这让模型侧名称与脚本语义一致，代价是 stock Windows 需要额外安装 Bash，且首版不引入 native Job Object helper：POSIX 终止受管理 process group，Windows 仅以 `taskkill /T /F` 提供明确标记的 best-effort process-tree cleanup。
