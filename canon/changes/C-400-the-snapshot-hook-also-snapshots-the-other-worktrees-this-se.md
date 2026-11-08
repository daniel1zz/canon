---
id: C-400
title: The snapshot hook also snapshots the other worktrees this session's
  actors have claimed (#139)
status: done
rules: []
passes:
  BR-2182: b1f09417b064c90b test
---

## 为什么

#139：`canon snapshot take --hook` 只快照 hook 输入的 `cwd` 所在的 worktree。Claude Code 给的 `cwd` 是会话起始目录，而 `canon work start` 让每个会话进 `<仓库>.worktrees/C-n` 干活，所以大部分 worktree 里的工作没有快照，一个 worker 用 `git checkout -- .` 丢了工作（P4）。

## 要改什么

hook 另外从认领表（只读）找出持有者是本会话或它的子 agent 的 worktree，各自照旧快照。BR-2182 加规则和两边的例子；新决策 D-71 修改 D-30 的这条后果，否决解析命令里的 cd。测试名引用 BR-2182。

## 陷阱和假设

会话取自 hook 输入的 `session_id` 前 8 位，与 `currentActor` 的 `slice(0, 8)` 一致；假设 hook 的 `session_id` 和 Bash 里的 `CLAUDE_CODE_SESSION_ID` 是同一个会话 id。耗时实测见 D-71。

## 教训

无。

## 任务

- [x] 实现、规则、决策、测试
