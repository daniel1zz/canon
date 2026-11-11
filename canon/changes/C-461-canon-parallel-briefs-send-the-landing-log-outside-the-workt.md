---
id: C-461
title: canon-parallel briefs send the landing log outside the worktree, so it
  cannot make the landing dirty
status: open
rules: []
---

## 为什么

canon-parallel 给子 agent 的说明里写“把 `canon work land --finish` 的输出重定向到一个日志文件”，没说放在哪。2026-11-11 的一轮并行里，4 个子 agent 把它写进自己的 worktree（`<worktree>/land.log`），这个未跟踪的文件让每次落地都以 dirty（退出码 2，BR-2105）被拒（事件 8205、8223、8267、8295）。负责人选择改 skill 原文，不给 canon 加特例（canon human #22）。

## 要改什么

- canon-parallel 的 Landing 一条写明日志放在 worktree 之外（scratchpad 或 `/tmp`），并说明原因。
- 不在范围内：canon 忽略某个文件名。

## 教训

- 子 agent 照着说明把日志写进 worktree，4 次落地以 dirty 被拒 → 现在由 canon-parallel 的 Landing 一条写明位置保证（只靠文字：负责人选择不加 canon 的机制，canon human #22）

## 任务

- [x] 改 canon-parallel 的 Landing 一条
