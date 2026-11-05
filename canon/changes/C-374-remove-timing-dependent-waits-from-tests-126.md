---
id: C-374
title: Remove timing-dependent waits from tests (#126)
status: done
rules: []
---

## 为什么

解决 #126 的一部分：全量测试（floor）反复因个别测试撞 30 秒超时而失败，每次是不同的测试，单独跑都能过。负责人要求去掉测试里有隐患的等待。

本变更处理“假进程”这一类：测试里用 `sleep 30` / `sleep 60` 起来假装长时间运行的进程，靠被测代码或测试杀掉。它们会自己跑满 30 秒结束：杀不掉或信号晚到时，测试要么一直等到撞全局超时，要么在负载高、测试跑过 30 秒时，进程自然结束而让“进程已经没了”的断言假通过。另外还有几处靠猜一个时长的等待（`Bun.sleep(150)` 等“让 shell 先起来”、`sleep 1; touch late` 再等 1.5 秒确认没写出来）。

## 要改什么

只改测试和测试公用代码（src/work/testkit.ts），不改产品代码，不改规则：每个测试仍然证明它点名的规则，断言不放松。

- testkit 新增 `HANG_SECONDS`（120 秒，比任何测试超时都长，假进程在测试期间不会自己结束，但有限，runner 被 SIGKILL 时不会留下很久）、`hang()`（起一个假的活进程，afterEach 一定杀掉，失败的测试也杀）、`alive`、`waitGone`（进程该没了：最多等 5 秒，超了立刻以清楚的信息失败）、`waitFor`（轮询到条件成立，有上限，超了说明在等什么）。
- 全部 `sleep 30/60/90` 的假进程换成 `HANG_SECONDS`；放进 floor/hook 的用 `exec sleep`，杀进程组时不留孤儿。
- `Bun.spawn(["sleep", "30"])` 换成 `hang()`。
- verify.test.ts、stop-groups.test.ts：靠 sleep 猜“已经启动”的地方换成标记文件；无上限的 `while ... await Bun.sleep(25)` 换成 `waitFor`；用 sleep 排“信号先后”的地方换成由测试控制的标记（进程已退出、停止已开始）；“再等一会儿确认没发生”的睡眠去掉（前面已经 await 了全部结束）。
- watch.test.ts：`sleep 1; touch late` 再睡 1.5 秒确认文件没出现，换成让被留下的进程写自己的 pid、测试直接检查这个进程是否还活着（BR-2285 的各条）。

## 教训

无。

## 任务

- [x] testkit 新增 hang/waitGone/waitFor
- [x] 假进程换成不会自己结束、一定被清理的写法
- [x] 猜时长的等待换成标记或条件轮询
