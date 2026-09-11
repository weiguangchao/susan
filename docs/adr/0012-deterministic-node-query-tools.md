# 查询 Tool 的 Node 遍历契约已退役

> 已取代：[任务：find 重写对齐 Pi](https://github.com/weiguangchao/susan/issues/105) 确立 Find Tool 经 Managed Binary `fd` 搜索。Grep Tool 已改为经 Managed Binary `rg` 搜索，Ls Tool 已改为 Node `readdir` 纯文本列表。三者均不再适用本决策。

Find Tool 使用 Node/TypeScript 原生文件系统遍历，不调用或下载宿主机的 `find` 或 `fd`；它使用平台无关 glob、`.gitignore`、symlink、ordinal 排序、Traversal Diagnostic 与确定性分页。Grep Tool 已改为经 Managed Binary `rg` 搜索，Ls Tool 已改为 Node `readdir` 纯文本列表，二者不再适用本决策。
