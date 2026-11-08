---
id: C-403
title: The snapshot hook snapshots only the claims of the calling actor, not of
  sibling subagents (#139)
status: open
rules: []
---

## 为什么

C-400 让 hook 快照本会话所有认领的 worktree，但并行子 agent 和主会话共用会话 id，所以每个 agent 的每次调用都快照所有兄弟的 worktree：4 个有改动的子 agent 时每次调用多约 1 秒（#139 的后续）。

## 要改什么

只快照调用者自己的认领：输入有 `agent_id` 时找 `agent:<会话>:<agent_id>`，没有时找恰好 `agent:<会话>`。BR-2182 改规则和例子，D-71（还是 proposed）原地改，写上实测耗时。

## 陷阱和假设

假设子 agent 的 `--as` 名字等于 hook 输入的 `agent_id`（`canon work check-as` 强制，D-62）。不并行处理各 worktree：见 D-71 后果。

## 教训

无。

## 任务

- [x] 代码、BR-2182、D-71、测试
