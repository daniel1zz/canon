---
id: C-421
title: D-75 states which stops still lose the place and is accepted
status: open
rules: []
---

## 为什么

C-410 按 D-75 修了 #148：合入超时或被 SIGTERM、SIGINT 终止后，在 `land_keep_place_minutes` 内保留排队位置。D-75 合入时是 proposed。主会话另派了一个独立评审，只给它问题和方案，评审同样选了这个方案。不过它从 BR-2177 的文字和代码里已经看到了采用的是哪个，这一点它自己说明了。

评审指出两点：

- `kill -9` 或心跳停止时，条目被别的合入者标成 `abandoned`，仍然失去位置。查 zhushenkongjian 的队列表：停止等待的条目里有 13 个是 `abandoned`，54 个是 `killed`，12 个是 `timeout`，所以这不是罕见情况。
- 可以用很短的 `--timeout` 反复排队，占住位置。

## 要改什么

- D-75 写明实测数字，并说明被放弃的条目也保留位置，由另一个变更做。
- D-75 写明反复超时占位置这种情况，以及为什么不限制。
- 接受 D-75。
- 不改规则和代码。

## 教训

无

## 任务

- [x] D-75 补充
- [x] 接受 D-75
