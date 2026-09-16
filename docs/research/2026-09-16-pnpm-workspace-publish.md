# pnpm workspace 发布时如何改写 `workspace:` 协议

> 日期：2026-09-16
> 范围：回答 [调研：pnpm workspace 发布时如何改写 workspace: 协议](https://github.com/weiguangchao/susan/issues/111)。只核验 pnpm 官方文档与本仓库实际使用的 pnpm 大版本行为，不替 Susan 做拆包实现。
> 证据快照：本仓库 `pnpm -v` = **10.34.5**（`pnpm-lock.yaml` `lockfileVersion: '9.0'`，无 `packageManager` 字段）。事实取自 pnpm 10.x 官方文档与 [`pnpm/pnpm@v10.34.5`](https://github.com/pnpm/pnpm/tree/v10.34.5) 源码/测试。官网默认页已切到 12.x，下文一律用 [10.x 文档](https://pnpm.io/10.x/workspaces)。

已决定、本文不重开：两个包 `packages/tui`（`@weiguangchao/susan`，唯一 bin）与 `packages/harness`（`@weiguangchao/susan-harness`，进程内库）；独立 semver；0.x 期间仓库里 TUI 写 `workspace:*`，发布时钉死精确 Harness 版本；两包都发 npm。当前仍是单包，`pnpm-workspace.yaml` 只有 `allowBuilds` / `patchedDependencies`，尚无 `packages` glob。

## 结论先行

| # | 问题 | 结论 |
|---|---|---|
| 1 | `pnpm publish` / `pnpm pack` 如何改写 `workspace:*` / `workspace:^` | **内建改写**。tarball 里的 `package.json` 由 `createExportableManifest` 生成，不改磁盘上的源文件。`workspace:*` / 空 `workspace:` → 精确版本；`workspace:^` → `^<当前版本>`；`workspace:~` → `~<当前版本>`；其它范围原样去掉协议前缀 |
| 2 | 一次 commit 能否只发其中一个包 | **能**。`pnpm --filter <pkg> publish` 发单个；`pnpm -r publish` 只发 registry 里还没有的版本。不要求同 commit 两包一起发 |
| 3 | 发布后 TUI tarball 里 Harness 依赖是不是精确版本 | **是，当且仅当** TUI 写成 `workspace:*`（或空 `workspace:` / `workspace:<exact>`）。写成 `workspace:^` 会变成 `^<harness.version>`，**不是**精确钉死 |
| 4 | changeset 是否必需 | **可选**。pnpm 自己改写协议并发布；changeset / Rush 只补「独立 semver 的 bump / changelog」这一层。pnpm 官方写明自己不做 workspace versioning |
| 5 | 0.x / `workspace:*` 会不会把「发布钉死精确版本」弄破 | **`workspace:*` 本身不会**。会弄破的是：`workspace:^`（0.x 下 `^0.1.0` ≡ `>=0.1.0 <0.2.0`，不是精确钉）、依赖未 install（`CANNOT_RESOLVE_WORKSPACE_PROTOCOL`）、只发 TUI 却没先把对应 Harness 版本推上 registry |

## 一、本仓库实际跑的是 pnpm 10，不是官网默认的 12

- 本机 `pnpm -v`：**10.34.5**
- lockfile：`lockfileVersion: '9.0'`（pnpm 9/10 的 lockfile）
- `package.json` 无 `packageManager` 字段；`pnpm-workspace.yaml` 目前只有 `allowBuilds` 与 `patchedDependencies`

10.x 文档已标注 no longer actively maintained，默认站切到 12.x。与本题相关的 `workspace:` 改写规则、`--filter`、`pnpm -r publish` 在 10.x 与当前 12.x workspace 页文字一致。差异不影响本题：

- 10.x 的 `pnpm publish` 仍委托 `npm publish` 上传 tarball（[publish.ts 调 `runNpm(..., ['publish', tarball, ...])`](https://github.com/pnpm/pnpm/blob/v10.34.5/releasing/plugin-commands-publishing/src/publish.ts)）；12.x 文档写「Since v11, `pnpm publish` is implemented natively」。改写发生在 pack 阶段，上传客户端换不换都不改协议替换规则
- 12.x 才有 `--batch` / `--skip-manifest-obfuscation`；10.34.5 没有

## 二、`workspace:` 在 pack/publish 时怎么改

### 文档规则

[pnpm 10.x Workspace · Publishing workspace packages](https://pnpm.io/10.x/workspaces#publishing-workspace-packages)：

> When a workspace package is packed into an archive (whether it's through `pnpm pack` or one of the publish commands like `pnpm publish`), we dynamically replace any `workspace:` dependency by:
>
> - The corresponding version in the target workspace (if you use `workspace:`, `workspace:*`, `workspace:~`, or `workspace:^`)
> - The associated semver range (for any other range type)
>
> A bare `workspace:` without a version range is treated as `workspace:*`.

文档示例（工作区包都是 `1.5.0`）：

| 源 spec | 发布后 |
|---|---|
| `workspace:*` | `1.5.0` |
| `workspace:~` | `~1.5.0` |
| `workspace:^` | `^1.5.0` |
| `workspace:^1.5.0` | `^1.5.0` |

空 `workspace:` 自 [v10.29.1](https://github.com/pnpm/pnpm/blob/v10.34.5/pnpm/CHANGELOG.md) 起按 `workspace:*` 处理。

### 源码：改写发生在 tarball 的 `package.json`，不改磁盘

`pnpm pack` 与 `pnpm publish` 共用 [`pack.api`](https://github.com/pnpm/pnpm/blob/v10.34.5/releasing/plugin-commands-publishing/src/pack.ts)。`publish` 先 pack 到临时目录，再 `npm publish <tarball>`，避免 npm 读到当前目录里仍带 `workspace:` 的源 `package.json`：

```ts
// releasing/plugin-commands-publishing/src/publish.ts
// We have to publish the tarball from another location.
// Otherwise, npm would publish the package with the package.json file
// from the current working directory, ignoring the package.json file
// that was generated and packed to the tarball.
const { tarballPath } = await pack.api({ ...opts, dir, packDestination, dryRun: false })
runNpm(opts.npmPath, ['publish', '--ignore-scripts', path.basename(tarballPath), ...args], {
  cwd: packDestination,
})
```

pack 把改写后的 manifest 直接写进 tarball 的 `package/package.json`：

```ts
if (/^package\/package\.(?:json|json5|yaml)$/.test(name)) {
  pack.entry({ mode, mtime, name: 'package/package.json' }, JSON.stringify(manifest, null, 2))
}
```

改写函数是 [`createExportableManifest` → `replaceWorkspaceProtocol`](https://github.com/pnpm/pnpm/blob/v10.34.5/pkg-manifest/exportable-manifest/src/index.ts)：

```ts
const versionAliasSpecParts = /^workspace:(?:(.+)@)?([\^~*])?$/.exec(depSpec)
if (versionAliasSpecParts != null) {
  const manifest = await readAndCheckManifest(depName, path.join(modulesDir, depName))
  const specifierSuffix: string | undefined = versionAliasSpecParts[2]
  const semverRangeToken = specifierSuffix === '^' || specifierSuffix === '~' ? specifierSuffix : ''
  if (depName !== manifest.name) {
    return `npm:${manifest.name!}@${semverRangeToken}${manifest.version}`
  }
  return `${semverRangeToken}${manifest.version}`
}
```

对应关系：

| 源 spec | 发布后（同名依赖） |
|---|---|
| `workspace:*` / `workspace:` | `<installed.version>`（精确） |
| `workspace:^` | `^<installed.version>` |
| `workspace:~` | `~<installed.version>` |
| `workspace:1.0.0` | `1.0.0`（去掉协议） |
| `workspace:^1.0.0` | `^1.0.0`（去掉协议，保留范围） |
| `workspace:../foo` | `<foo.version>` 或 `npm:<real-name>@<version>` |
| `workspace:other@*` | `npm:other@<version>` |

版本读的是 **`node_modules/<dep>/package.json` 里已安装的 workspace 包**，不是「registry 上最新的」。没 install 就 pack/publish 会抛 `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`（「this dependency is not installed. Try running pnpm install」）。单元测试 [`workspace deps are replaced`](https://github.com/pnpm/pnpm/blob/v10.34.5/pkg-manifest/exportable-manifest/test/index.test.ts) 与此一致：`foo: 'workspace:*'` → `'4.5.6'`，`qux: 'workspace:^'` → `'^1.0.0-alpha-...'`。

对 Susan：TUI 写 `"@weiguangchao/susan-harness": "workspace:*"`，Harness 当时是 `0.1.2`，则 TUI tarball 里是 `"@weiguangchao/susan-harness": "0.1.2"`。磁盘上的 TUI `package.json` 仍是 `workspace:*`。

## 三、一次 commit 只发其中一个包

pnpm 10.x 支持按包过滤：

- [`pnpm publish --filter <package_selector>`](https://pnpm.io/10.x/cli/publish#--filter-package_selector) / [`pnpm pack --filter`](https://pnpm.io/10.x/cli/pack#--filter-package_selector)（pack 的 filter 自 v10.11.0）
- [Filtering](https://pnpm.io/10.x/filtering)：`--filter @weiguangchao/susan` 只选 TUI；`--filter @weiguangchao/susan-harness` 只选 Harness
- 也可进包目录直接 `pnpm publish`（`publish.ts` 在 `opts.recursive` 为假时走单包路径）

`pnpm -r publish` 的语义是「workspace 里所有 **registry 尚无该 version** 的包」，不是「这次改过的包」：

```ts
// recursivePublish.ts
if (!pkg.manifest.name || !pkg.manifest.version || pkg.manifest.private) return false
if (opts.force) return true
return !(await isAlreadyPublished(..., pkg.manifest.name, pkg.manifest.version))
```

因此：

- 只 bump TUI 再 `pnpm -r publish` → 只发 TUI（Harness version 已在 registry 则跳过）
- 只 bump Harness → 只发 Harness
- 两包 version 都变了 → 两包都发，按 `sortPackages` 拓扑顺序（Harness 先于依赖它的 TUI）
- 想强制「这次只发 TUI」：`pnpm --filter @weiguangchao/susan publish`，不要裸 `-r`

`gitChecks` 默认开：工作树必须干净、分支是 `master`/`main`（可用 `publishBranch` 改）、与 remote 同步。CI 单包发布需要 `--no-git-checks` 或把 `gitChecks: false` / `publishBranch` 写进 `pnpm-workspace.yaml`。

## 四、changeset 可选，pnpm 单独做不到独立 semver bump

[Release workflow](https://pnpm.io/10.x/workspaces#release-workflow)：

> Versioning packages inside a workspace is a complex task and pnpm currently does not provide a built-in solution for it. However, there are 2 well tested tools that handle versioning and support pnpm: changesets, Rush.

pnpm 负责：link、`workspace:` 解析、pack 时改写、按 filter/`-r` 发布。不负责：决定哪个包 bump、写 changelog、把 `workspace:*` 在磁盘上改成精确版本（它也不需要改磁盘）。

[Using Changesets with pnpm](https://pnpm.io/10.x/using-changesets) 的推荐流程是 `changeset version` → `pnpm install` → commit → `pnpm publish -r`。changeset 不是协议改写的前置条件。

两包独立 semver、一次 commit 只发其中一个，用 pnpm 就够：手动改对应 `package.json` 的 `version`，再 `--filter` publish。changeset 只是把 bump/changelog/CI 自动化；两包、低频发布时可以不上。

## 五、0.x 与「发布钉死精确版本」的坑

目标：仓库里 TUI 写 `workspace:*`，**已发布的 TUI tarball** 钉死当时的 Harness 精确版本。

1. **必须用 `workspace:*`（或空 `workspace:` / `workspace:<exact>`），不要 `workspace:^`。**  
   `workspace:^` → `^0.1.2`。npm caret 在 0.x 是「锁 minor」：`^0.1.2` ≡ `>=0.1.2 <0.2.0`（[node-semver Caret Ranges](https://github.com/npm/node-semver/blob/v7.7.4/README.md#caret-ranges-123-025-004)）。这不是精确钉死，且 0.x 的 patch 仍可能进 breaking（[SemVer §4](https://semver.org/#spec-item-4)：Major version zero, anything MAY change）。`saveWorkspaceProtocol` 默认 `rolling` + `savePrefix` 默认 `'^'`，`pnpm add @weiguangchao/susan-harness` 会写成 `workspace:^`。TUI 依赖要手写 `workspace:*`，或设 `savePrefix: ''`。

2. **改写读的是已安装的 Harness version。**  
   pack/publish 前必须 `pnpm install`，且 `node_modules/@weiguangchao/susan-harness` 指向当前 workspace 包。否则 `CANNOT_RESOLVE_WORKSPACE_PROTOCOL`。

3. **先发 Harness，再发依赖它的 TUI。**  
   协议改写不替你把 Harness 推上 registry。只发 TUI、tarball 钉 `0.1.2`、registry 没有该版本 → 用户 `npm i -g @weiguangchao/susan` 失败。`pnpm -r publish` 按拓扑排，同一次递归发布没这个问题；`--filter` 只发 TUI 时要自己保证对应 Harness 版本已在 registry。

4. **磁盘上的 `package.json` 不会变成精确版本。**  
   这是对的：开发继续用 `workspace:*`。验证钉死要 `pnpm pack` 后看 tarball 内 `package/package.json`，不要看仓库源文件。

5. **当前 `pnpm-workspace.yaml` 没有 `packages` glob。**  
   pnpm 10.32.1 修过「只有 settings、没有 `packages` 时把所有目录当 workspace 项目」。拆包时必须显式加 `packages:`（例如 `packages/*`），不能只靠现有的 `allowBuilds` / `patchedDependencies`。

6. **`linkWorkspacePackages` 默认 `false`。**  
   不用 `workspace:` 协议时，同名包会走 registry。TUI 必须写 `workspace:*`，不能写成普通 `"0.1.2"`，否则开发期可能装到旧的已发布 Harness。

7. **10.x publish 仍走 npm CLI。**  
   scoped 包首次公开发布需要 `--access public`（[npm-publish access](https://docs.npmjs.com/cli/v10/commands/npm-publish#access)）。这与协议改写无关，但拆包后第一次发 `@weiguangchao/susan-harness` 会踩。

## 对 Susan 拆包发布的可执行含义

仓库：

```json
"dependencies": {
  "@weiguangchao/susan-harness": "workspace:*"
}
```

发布（pnpm 10.34.x）：

```bash
pnpm install
pnpm --filter @weiguangchao/susan-harness publish --access public
pnpm --filter @weiguangchao/susan publish --access public
```

或 bump 完 version 后一次 `pnpm publish -r --access public`。TUI tarball 里会是 `"@weiguangchao/susan-harness": "<当时 harness.version>"`，不是 `workspace:*`。changeset 不是实现这条链路的前提。
