# 认领（work/claims）

同一个变更同一时间只能由一个 worktree 里的一个执行者在做。认领有租约（默认 12 小时），持有者的 `canon work land` 和不带 `--release` 的 `canon work stop` 会续期（租约有效时 `canon work start` 总是被拒绝，BR-2011）；在 Claude Code 里还记下会话进程（pid 和 UTC 启动时间），进程已经不在时认领可以立刻被接手，不用等租约到期（D-11）。子 agent 是单独的执行者（D-17）：它的认领只有它自己能续期、停下、放开和合入，主会话只能用 `--takeover` 显式放开（BR-2129）。

不管：认领在开始、合入、放弃时怎么被使用，那些在各自的子领域里。

## 术语

- **租约**：认领到期的时间，配置 `claim_lease_hours`。
- **会话进程**：`CLAUDE_PID` 指向、且确实是当前进程祖先的 Claude Code 进程。
- **占位（hold）**：`clean` 和 `drop` 删除期间临时占住认领，防止别人同时接手。
