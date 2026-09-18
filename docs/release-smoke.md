# 三包 Release Gate

本阶段只验证源码与本地原始 tarball，不发布到 npmjs，也不验证 registry 最低版本或正常范围解析组合。本机通过不等同于跨平台 Release Gate 通过。

## 检查顺序

从仓库根目录依次执行整个 workspace 的 typecheck、测试与构建：

```sh
pnpm --filter @weiguangchao/susan-core typecheck
pnpm --filter @weiguangchao/susan-harness typecheck
pnpm --filter @weiguangchao/susan typecheck

pnpm --filter @weiguangchao/susan-core test
pnpm --filter @weiguangchao/susan-harness test
pnpm --filter @weiguangchao/susan test

pnpm --filter @weiguangchao/susan-core build
pnpm --filter @weiguangchao/susan-harness build
pnpm --filter @weiguangchao/susan build
```

随后按依赖顺序检查每个包的原始 tarball：

```sh
pnpm --filter @weiguangchao/susan-core package:smoke
pnpm --filter @weiguangchao/susan-harness package:smoke
pnpm --filter @weiguangchao/susan package:smoke
```

每个 smoke 在仓库外安装未经改写的本地 tarball，运行普通 Node JavaScript，并记录实际安装依赖。Harness 与 TUI 的临时消费者通过本地 registry 配置获得内部依赖 tarball，不使用 workspace link、源码路径或 `tsx`。

## 自动平台矩阵

| 平台 | Node | core | Harness | TUI |
| --- | --- | --- | --- | --- |
| macOS | 22 | 必需 | 必需 | 必需 |
| Linux | 22 | 必需 | 必需 | 必需 |
| Linux | 24 | 必需 | 必需 | 必需 |
| Windows | 22 | 必需 | 必需 | 必需 |

各主机直接执行上面的包级命令。不恢复 GitHub Actions，也不使用远端 workflow 或 job 名代替结果。

## 自动验收记录

每份记录对应一个平台上的实际产物，至少包含：

| Commit | 包 | 版本 | tarball SHA-256 | 实际内部依赖 | 平台 | Node | 执行人 | 日期 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |  | 尚未执行 |

结果只能写“尚未执行”“失败”或“通过”。缺少任一必需平台记录或存在失败项时，Release Gate 不通过。TUI 还必须完成 [人工验收清单](../packages/tui/docs/release-smoke.md)。
