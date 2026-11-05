---
id: C-377
title: Wait for killed processes to be gone instead of asserting it at once (#126)
status: open
rules: []
---

## 为什么

解决 #126 验证中发现的一个竞争：两份全量测试同时跑时，verify.test.ts 的 `BR-2304: a second signal ends the wait at once and sends SIGKILL ...` 失败了一次（`expect(alive(pid)).toBe(false)` 得到 true）。canon 退出的那一刻，被 SIGKILL 的子进程还没被收走（进程表里还在），测试立刻检查就看到它还活着；负载高时这个间隔更长。同文件里还有两处同样的“进程刚被杀就立刻断言它没了”。

## 要改什么

只改测试：这三处改成 `waitGone(pid, ...)`（最多等 5 秒，超了立刻以清楚的信息失败），断言本身不放松：进程必须是被这次停止杀掉的（它的寿命是 HANG_SECONDS，不会自己结束）。

## 教训

无。

## 任务

- [x] 三处“刚被杀就断言没了”改成 waitGone
