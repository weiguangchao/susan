# Write 与 Edit 采用可检测冲突的文件替换提交点

> 部分已取代：[决策：read、write、edit 的 Tool 文案](https://github.com/weiguangchao/susan/issues/91#issuecomment-5628278674) 确立 Pi 对齐；write/edit 跟随最终 symlink，使用共享文件写入队列与直接写盘，移除临时文件替换和冲突复检。以下保留原决策历史。

Susan 的 `write` 与 `edit` 使用目标同目录的独占临时文件写入并 flush，在提交前复核目标是否发生可观测变化，再以 rename/replace 一次提交；提交前失败或取消不改变目标，替换成功后即视为成功且不尝试回滚。相比直接覆写，这优先避免部分内容并防止可检测的外部修改被覆盖，代价是 hard link 会分离、Windows 只承诺 best-effort replacement，且 owner、ACL、xattr 与恶意并发下的 TOCTOU 不在跨平台保证内。
