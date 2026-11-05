---
id: C-375
title: Replace fixed deadlines and script sleeps in tests with conditions (#126)
status: open
rules: []
---

## 为什么

解决 #126 的另一部分（C-374 处理了假进程）：测试里有几类等待，通过与否取决于“等够了一段墙钟时间”，负载一高就失败或拖到撞 30 秒超时：

- `Bun.sleep(2500)` 等固定期限（finish.test.ts、boundaries.test.ts、keep-place.test.ts）：靠猜“过了租约/过了一次轮询”。
- git hook、setup、before_land、after_land 里的 `sleep N`（interrupted、lander、keep-place、boundaries、batch、batch-edges、uninstall）：靠猜“慢步骤还没结束”，测试再 `Bun.sleep` 等它结束。
- `Bun.sleep(300)` 之类“让 lander 先排上队”。
- 一个测试里连续多次同步启动 canon CLI（questions.test.ts 的 BR-2021 选项那条用了十几次），负载高时每次都慢。

## 要改什么

只改测试，不改产品代码，不改规则，也不调大任何超时：每个测试仍然证明它点名的规则，断言不放松。

- 固定期限换成“轮询到条件成立，有上限，超了以清楚的信息失败”：租约（BR-2108）读 claim 的 expires_at，等到当前时间超过它，再断言 claim 没被拿走且已被续期；队列轮询（BR-2153、BR-2178、BR-2048/2172）把 lander 每次看队列都会更新的 heartbeat 当作“又看了一次”的标记；这些测试同时用 lander_stale_minutes 的小值让轮询间隔从 2 秒缩到 0.6 秒，并让被测队列里的假条目自己续 heartbeat，不改产品默认值。
- 脚本里的 `sleep N` 换成“等到标记文件出现才放行”（上限 LOOP_SECONDS）：测试先做完要做的事（杀 lander、改队列状态、发信号）再放行，完成顺序由标记文件决定，和 C-345 修 #124 的做法一样。
- 等 lander“排上队”换成等队列里出现它的条目；等 lander 处理完信号换成等它打印的那一行。
- questions.test.ts：同一条规则的“只在进程内就能证明”的情形改成直接调用 answer()/ask()，各留一次真实 CLI 的拒绝（退出码 1、5）和接受，保证从真实入口跑过（canon-rules 第 7 节）。

## 陷阱和假设

- 依赖 C-374 加进 testkit 的 `waitFor`、`boundedLoop` 等；本变更在它合入后基于 main。
- 没改的等待和原因写在 #126 的收尾评论里：产品自己的超时（review_timeout_minutes、remote_timeout_seconds）、pool.test.ts 的真实定时器、code-review-batch 里让三个评审重叠的 3 秒 AI。

## 教训

无。

## 任务

- [x] 固定期限换成条件轮询
- [x] hook / setup / before_land 里的 sleep 换成标记文件放行
- [x] 重复启动 CLI 的测试合并成进程内调用加一条真实入口
