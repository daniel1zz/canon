---
id: C-555
title: land --finish removes the landed worktree in the background once the
  landing has exited (#228)
status: done
rules:
  - BR-2486
passes:
  BR-2167: a1051c9e0f56d237 test
  BR-2486: d3ffc244cee93909 test
---

## 为什么

#228：`land --finish` 关闭变更后不删 worktree，只有手动 `canon work clean` 才删。worker 一天合入很多变更的项目里，合入过的 worktree 越积越多：有个项目一次清出 35 个，约 5.6 GB。

## 要改什么

新规则 BR-2486：`land --finish` 合入后，在后台跑 `canon work clean <变更> --after-landing`，删不删按 BR-2019 判断。合入进程和它的 shell 退出前都在 worktree 里，所以只在"有进程在里面"时重试，等两分钟左右；`canon work after-land --wait` 报告结果。代码在 `src/work/session/clean-after-land.ts`，由 finish.ts 启动，after-land.ts 报告。测试默认关掉这个后台删除（`CANON_CLEAN_AFTER_LAND=0`，在 testkit 里设置），免得它和查看或清理 worktree 的测试抢着删。

## 陷阱和假设

合入时如果交互式 shell 还停在 worktree 里，等两分钟后会保留，输出说明之后怎样手动删。删除不经过 `after_land` 钩子，没配 `after_land` 的项目也照样删。

## 教训

无
