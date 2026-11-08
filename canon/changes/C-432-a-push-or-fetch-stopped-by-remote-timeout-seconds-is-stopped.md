---
id: C-432
title: A push or fetch stopped by remote_timeout_seconds is stopped with the
  processes git started (#162)
status: done
rules:
  - BR-2260
passes:
  BR-2260: 9957e665f4604759 test
---

## 为什么

超过 `remote_timeout_seconds` 的推送或取远端只杀了 git 本身，它启动的 pre-push hook、`git-receive-pack`、`ssh` 被交给 pid 1 继续跑，canon 已经记了 push.fail，它们还在（#162）。

## 要改什么

git 放进自己的进程组（`detached: true`），超时后给整个组发 SIGTERM，宽限期后 SIGKILL（复用 `work/verify/stop-groups.ts`，加一个同步版本，因为 `gitRemote` 是同步的，调用方 `pushMain`、`sync` 不变）。BR-2260 的规则和例子写明终止包括 git 启动的进程。


## 教训

无

## 任务

- [x] 同步停组函数、gitRemote 用进程组、BR-2260 和两个测试
