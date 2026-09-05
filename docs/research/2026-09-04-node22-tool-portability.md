# Node 22 下 shell 与文件 Tool 的跨平台边界

## 范围

本文回答 [调研：Node 22 下跨平台 shell 与文件 Tool 的实现边界](https://github.com/weiguangchao/susan/issues/34)：在 macOS、Linux、Windows 且 Node.js >= 22 的约束下，one-shot 命令执行、取消与 timeout、进程树终止、替换写入、symlink 和目录遍历有哪些可依赖行为。

调研只使用 Node.js、POSIX 和 Microsoft 的官方文档或源码。Node.js 行为固定到 [`nodejs/node@v22.23.2`](https://github.com/nodejs/node/tree/v22.23.2)；本文不把本机实验或第三方库行为当作跨平台契约。

## 结论速览

| 主题 | 可依赖边界 | 对 Susan 的约束 |
| --- | --- | --- |
| shell 选择 | Node 的默认 shell 是 Unix `/bin/sh`、Windows `process.env.ComSpec`（缺失时回退 `cmd.exe`），不是跨平台 Bash | 模型侧 Tool 可以名为 `bash`，但 stock Windows 无法承诺 Bash 语法；必须在“宿主 shell”语义与“要求可配置 Bash 可执行文件”之间明确选一个 |
| timeout / cancel | `timeout` 和 `AbortSignal` 最终向直接子进程发送 `killSignal`，默认 `SIGTERM` | 二者可共用一次终止状态机，但不能宣称自动清理整棵进程树 |
| 进程树 | POSIX 可建立新 process group 后向 group 发信号；Windows 的 Node 信号是强制终止单进程 | 若要保证树终止，需要平台实现：POSIX process group；Windows Job Object。`taskkill /T` 只能作为依赖系统命令的较弱方案 |
| 写入替换 | `writeFile` 直接覆盖不是原子替换；POSIX 同文件系统 `rename` 有明确的 old-or-new 可见性；Windows Node 使用 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，但 Microsoft 未给出同等级的原子可见性保证 | 用同目录临时文件、flush、rename 实现“尽量原子替换”；跨平台产品契约不能写成无条件原子或 crash-safe |
| symlink / cwd 边界 | `path.resolve` 是路径字符串运算；`lstat` 才观察 link 本身，`realpath` 解析目标。Node Permission Model 也明确会跟随越界 symlink | cwd containment 不能只做字符串前缀检查；所有 Tool 共用显式 symlink policy，并承认无 OS sandbox 时仍有 TOCTOU 边界 |
| 遍历 | Node 22 原生 `opendir`/`readdir` 支持迭代和递归，无需依赖 `find`/`ls`/`rg` 程序 | `grep/find/ls` 可用 Node 实现稳定 schema；自行控制 symlink、排序、ignore、深度、结果上限和取消点 |

## 1. one-shot shell 选择

`child_process.exec()` 的 `shell` 默认值在 Unix 是 `/bin/sh`，在 Windows 是 `process.env.ComSpec`；`spawn(..., { shell: true })` 采用相同规则，也允许传入明确的 shell 路径。Node 对非 CMD shell 的最低约束是理解 `-c`，对 `cmd.exe` 则要求兼容 `/d /s /c`。[来源：Node `child_process` 文档，exec options](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L192-L203)、[shell requirements 与 Windows fallback](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L2319-L2331)。

这意味着 Node >= 22 本身没有“跨平台 Bash”保证：macOS/Linux 的默认值也只是 `sh`，Windows 默认是 CMD。Windows 的 `.bat`/`.cmd` 不能由 `execFile()` 直接启动，必须通过带 `shell` 的 `spawn()`、`exec()` 或显式 `cmd.exe`。[来源：Node Windows batch/cmd 说明](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L126-L170)。

因此实现票必须先固定名称与语义之一：

1. **宿主 shell Tool**：保留模型侧名称 `bash`，但文档明确其实际语法是 Unix `sh` / Windows CMD。优点是 stock OS 可用，缺点是名称误导且同一模型调用不可移植。
2. **真实 Bash Tool**：显式启动配置或探测得到的 Bash，并用 `-c`（是否 `-l` 另行决定）；Windows 若没有 Git Bash、WSL 或用户配置的 Bash 就返回“不可用”。这能保持名称真实，但不再是零依赖的 stock Windows 能力。
3. **改名为 shell**：语义最准确，但与已经确定的七个模型侧名称冲突。

仅从 Node/OS 可依赖行为看，推荐第 2 种；不要悄悄让 Windows CMD 冒充 Bash。无论选择哪种，都用异步 `spawn`/`exec` 收集 stdout/stderr，避免 sync API 阻塞 agent loop。命令字符串会被 shell 解释，Node 官方也反复警告不可把未清洗输入拼进 shell 命令；这里 Tool 的命令本来就是模型生成的完整程序，应把审批卡展示的原始命令视为最终执行单元，而不是再做参数拼接。[来源：Node `exec` 安全警告](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L242-L245)。

## 2. 取消、timeout 与进程树

### Node 公共 API 保证

异步 `spawn`/`exec` 同时支持 `AbortSignal` 与 `timeout`；二者使用 `killSignal`，默认 `SIGTERM`。`AbortSignal` 的区别主要是错误以 `AbortError` 返回，而不是提供更强的终止能力。[来源：Node spawn options](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L705-L720)、[AbortController 行为](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L888-L911)。

`subprocess.kill()` 只是向直接子进程发送信号，信号未必让进程退出。Windows 不存在 POSIX 信号；Node 只识别少数信号名并把终止处理为强制、突然的 kill。Node 还明确演示了 Linux 下杀掉 shell 不会杀掉 shell 启动的孙进程。[来源：Node `subprocess.kill`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L1690-L1730)。因此：

- timeout、用户 cancel、输出超限可以进入同一个终止状态机，并在结果中区分 `timedOut`、`aborted`、`outputLimitExceeded`；
- 状态机需要等待 `close`、持续 drain 两个输出流，并保留 `exitCode` / `signal`；
- 不能把 Node 内建 `timeout` 的完成解释为进程树已清理；
- 需要 graceful-then-forceful 时，POSIX 可先 `SIGTERM`，短 grace period 后 `SIGKILL`。Windows 的 Node signal 名并不提供 graceful 阶段。

### POSIX（macOS / Linux）

Node 在非 Windows 上用 `detached: true` 让子进程成为新 process group 和 session 的 leader。[来源：Node `options.detached`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/child_process.md#L916-L928)。POSIX `kill()` 规定负 PID（且不为 -1）会向绝对值对应的 process group 发信号。[来源：POSIX.1-2024 `kill()`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/kill.html)。

所以 POSIX 的 one-shot runner 可把 shell 放进独立 process group，并在取消时向 group 发信号；实现必须防止 PID/PGID 重用造成误杀，并只对自己刚创建且仍在跟踪的 group 操作。该机制覆盖一般后代，但刻意脱离该 group/session 的进程不受保证，因此契约仍应表述为“终止所管理的进程组”，而不是绝对的所有后代。

### Windows

Node 的公共 `ChildProcess.kill()` 没有进程树抽象。Windows 自带 `taskkill /T` 可终止指定进程及其启动的子进程，[来源：Microsoft `taskkill` `/T`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill#syntax)，但它是另一个外部命令，存在发现、权限、竞态和自身输出解析问题。

Windows 原生的强保证是 Job Object：它把一组进程作为单元管理，默认把成员创建的子进程纳入同一 job；`TerminateJobObject` 终止 job（包括嵌套 child jobs）中的所有进程。[来源：Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[`TerminateJobObject`](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)。这不是 Node 22 标准库 API，需要 native helper/addon 或经过审计的依赖。

首版若不引入 native 层，应明确标注 Windows 为 **best-effort tree cleanup**（可调用 `taskkill /PID <pid> /T /F`）；若规格要求“timeout 后不留后台进程”，则 Windows Job Object 是实现门槛，不能只靠 `AbortSignal`。

## 3. 替换写入与持久性

`fsPromises.writeFile()` 默认以 `w` 写入并替换现有内容；它内部可能执行多次 write，取消只是 best effort，取消后仍可能已有部分数据写入。`flush: true` 会在成功写完后调用 `filehandle.sync()`。[来源：Node `fsPromises.writeFile`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/fs.md#L1842-L1897)。所以直接对目标调用 `writeFile` 不满足“失败尽量保留原文件”。

推荐流程是：在目标的同一目录创建不可预测且排他的临时文件，完整写入并 `sync`，关闭句柄，再 `rename` 到目标；最后 best-effort 清理临时文件。放在同目录避免 POSIX 跨文件系统 `EXDEV`，也避免 Windows 跨 volume 退化为 copy + delete。Node 的 `x` / `O_EXCL` 在路径已存在时失败；POSIX 上最终组件是 symlink 时也失败，但 Node 明确提示 network filesystem 可能不支持该排他语义。[来源：Node file-system flags](https://github.com/nodejs/node/blob/v22.23.2/doc/api/fs.md#L8405-L8418)。

平台保证不同：

- POSIX 规定覆盖 rename 期间目标目录项始终可见，并引用 old 或 new 文件；除 `EIO` 外，rename 失败时原目标不受影响。[来源：POSIX.1-2024 `rename()`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)。同一文件系统、本地文件系统正常语义下，可以称为“原子可见替换”。
- Node 22.23.2 的 `fs.rename` 调用 libuv `uv_fs_rename`；其 bundled Windows 实现调用 `MoveFileExW(old, new, MOVEFILE_REPLACE_EXISTING)`。[来源：Node binding](https://github.com/nodejs/node/blob/v22.23.2/src/node_file.cc#L1415-L1471)、[bundled libuv Windows implementation](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/fs.c#L2266-L2272)。Microsoft 文档保证 `MOVEFILE_REPLACE_EXISTING` 在 ACL 条件满足时替换已有文件，但没有承诺与 POSIX 相同的 old-or-new 可见性；跨 volume 在允许时会退化为 copy + delete。[来源：Microsoft `MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw#parameters)。因此 Windows 只能承诺“使用 OS replace primitive，失败则报告”，不能无条件宣称 atomic。

`sync` 只覆盖临时文件内容；要讨论掉电后的目录项持久性，还涉及目录 fsync，而 Windows `MoveFileExW` 的 `MOVEFILE_WRITE_THROUGH` 并不是 Node `fs.rename` 暴露的选项。首版应把目标限定为“避免正常执行失败时留下半写文件”，不要承诺 crash-safe / power-loss durability。

替换临时 inode 还会改变原文件的 mode、ownership、ACL、xattr 等元数据。若 `write/edit` 规格要求保留元数据，需要单独列出可移植子集并测试；否则明确只保证内容替换。

## 4. symlink 与 cwd containment

`node:path` 默认采用宿主平台的路径规则；Windows 还有 per-drive cwd，`C:` 与 `C:\\` 的解析可能不同。[来源：Node path Windows vs POSIX](https://github.com/nodejs/node/blob/v22.23.2/doc/api/path.md#L20-L65)。因此路径层应只接受一次解析后的绝对路径对象，不用字符串拼接或简单 `startsWith(cwd)` 判断 containment。

Node 的 `lstat` 在最终组件是 symlink 时检查 link 自身，而 `stat` 会检查其目标。[来源：Node `fsPromises.lstat`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/fs.md#L1193-L1211)。这足以实现明确策略，但不是竞态免疫的 sandbox。尤其是 Node 自带 Permission Model 都公开说明 symlink 会被跟随到授权路径之外，且该模型不是对恶意代码的安全边界。[来源：Node Permission Model 限制](https://github.com/nodejs/node/blob/v22.23.2/doc/api/permissions.md#L13-L21)、[symlink 已知问题](https://github.com/nodejs/node/blob/v22.23.2/doc/api/permissions.md#L213-L218)。

建议七个 Tool 共用以下规则：

- 先按平台规则解析输入；Windows 拒绝含糊的 drive-relative `C:foo`，只接受普通相对路径或 fully-qualified absolute path；
- read/grep/find/ls 若允许跟随 symlink，审批范围依据解析后的真实目标，而不是 link 的表面路径；递归默认不跟随目录 symlink，避免环与越界；
- write/edit 对已有目标先 `lstat`。首版可拒绝最终目标为 symlink；新文件则解析最近的已存在祖先并检查其真实位置；
- 在检查和 open/rename 之间，其他进程仍可替换路径组件。没有目录句柄相对操作、OS sandbox 或平台专用 primitive 时，应把这记录为 TOCTOU 限制，不能声称 cwd 是硬安全边界；
- `yolo` 只跳过审批，不改变解析、symlink 和输出限制。

这与已确定的“没有 OS sandbox，进程拥有用户权限”一致：cwd 规则是 Tool policy 与审批输入，不是内核强制隔离。

## 5. `grep` / `find` / `ls` 的 Node 实现边界

Node 22 的 `fsPromises.opendir()` 提供异步迭代，并支持递归；`fsPromises.readdir()` 也支持 `recursive` 与 `withFileTypes`。[来源：Node `opendir`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/fs.md#L1340-L1391)、[`readdir`](https://github.com/nodejs/node/blob/v22.23.2/doc/api/fs.md#L1393-L1424)。因此专用文件 Tool 不必依赖宿主机存在 `rg`、GNU/BSD `find` 或某个 `ls` 版本。

但原生递归只提供枚举能力，不替 Susan 决定产品语义。稳定实现仍须自行控制：

- 是否包含 dotfiles、symlink、目录本身以及不可读项如何报错；
- glob/regex 的方言、大小写、二进制与非法 UTF-8 行为；
- 确定性排序（不可把文件系统枚举顺序当契约）；
- 最大深度、最大访问项、最大读取 bytes、结果条数/bytes 截断以及 continuation 信息；
- 每个目录项和文件块之间检查 AbortSignal，避免“已取消但长遍历继续占用 I/O”；
- 捕获单项错误还是终止整个 Tool，并在结果中保留 partial/truncated/error 元数据。

对大树优先 `opendir` 异步迭代或逐层 `readdir({ withFileTypes: true })`，不要一次 `readdir({ recursive: true })` 后才截断：后者可能在 Susan 有机会执行预算检查前就收集完整数组。`grep` 同样应流式逐文件/逐块读取，而不是 `readFile` 整文件载入。

## 6. 可直接写入规格的边界

1. `bash` 首版是 one-shot，无 PTY、持续 session、后台进程或后续 stdin；命令、cwd、环境、timeout、输出上限和取消原因进入结构化结果。
2. 若保留 `bash` 名称，应要求真实 Bash 可执行文件并允许配置路径；Windows 未配置 Bash 时返回明确 capability error。若产品必须 stock Windows 零依赖，则应回到地图重新决定 Tool 名称/语义。
3. timeout/cancel 必须尝试终止受管理进程树。POSIX 用独立 process group；Windows 若无 Job Object 只能标记 best-effort，不能把直接子进程退出视为树已清理。
4. `write/edit` 用同目录临时文件 + flush + rename；契约写“尽量原子替换，失败尽量保留原目标”。只在 POSIX 支持的本地同文件系统条件下声称 old-or-new 可见性，不承诺跨平台 crash-safe。
5. `read/write/edit/grep/find/ls` 共享路径解析和 symlink policy；cwd containment 触发审批，但在没有 OS sandbox 时不是安全隔离。
6. `grep/find/ls` 用 Node 文件 API 实现，不依赖外部二进制；明确顺序、错误、symlink、预算、截断和取消语义，并为 macOS/Linux/Windows 建立契约测试矩阵。

## 待实现阶段验证

- macOS/Linux：shell 退出后孙进程是否仍在、process-group 的 TERM -> grace -> KILL 路径、主动 cancel 与 timeout 的竞态。
- Windows：真实 Bash 的配置/发现策略；`taskkill /T /F` best-effort 路径或 Job Object helper；目标被其他进程打开时 replace 的失败结果。
- 三平台本地文件系统：新建、覆盖、rename 失败、权限错误、临时文件清理、symlink 指向 cwd 外、遍历 symlink 环、巨大目录和超长/二进制文件。
- 单独标记 network filesystem；Node 已明确排他创建可能不可靠，不能从本地 APFS/ext4/NTFS 测试外推。
