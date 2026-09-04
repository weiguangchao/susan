# Session Transcript 以 append-only JSONL 持久化

susan 0.0.1 将每个 Session 存为单个 JSONL 文件：首行 header，后续为 message / compaction 等 append-only record。这个格式与 Session Transcript、Model Context、Compaction Checkpoint 的分层相匹配，可在稳定边界即时落盘，也能在进程退出后恢复；相比整文件重写，它牺牲了原地更新与磁盘空间，换来审计、恢复与写入安全。读取时丢弃最后一条不完整 JSON line，继续写入前确保文件以换行结尾。
