---
cpu_light: "这一段只写设计稿（规则、决定），由 Opus 设计 worker 做，不跑测试和构建"
id: C-693
title: delegations declare light or heavy; the load limit gates the heavy steps,
  whoever runs them (#305)
status: open
rules:
  - BR-2630
  - BR-2631
  - BR-2632
  - BR-2633
issues:
  - 305
owner_gate: "none: 负责人在 #305 写明了期望的行为"
advances: "none: R-1 的成功标准没有覆盖按负载管重活"
---

## 为什么

负载高时 `canon work delegate` 对所有派发一律拒绝（BR-2526），设计、调研这类几乎不占 CPU 的工作也派不出去；而真正加负载的测试、构建、录制，由已经派出去的 worker 继续跑，没有任何限制（#305，zhushenkongjian 2026-11-22 负载 22 到 27、8 核，四个设计阶段的变更派不出去）。C-688 的 `cpu_light` 写在变更上，但同一个变更常常先轻（设计）后重（实现），轻重属于派发这一段。另外负责人定：Opus 级 worker 可以设计并自己开变更（#304，“变更也是。opus模型可以开”），现在 worker 一律不能开变更，主会话成了瓶颈。

## 要改什么

第一部分（D-161）：
- 新规则 BR-2632（work/delegation）：`canon work delegate --light "<理由>"` 轻派发，不看负载，内存和名额照查；轻改重时查负载；`canon work status` 写出理由；合入提醒从 BR-2627 移过来。
- 新规则 BR-2630（work/verify，新业务“重步骤等负载”）：重步骤（`canon work test`、合入的 floor 和补跑的测试、后台 floor watch、`canon heavy run`）负载达到上限时在整机负载队列里等，一次放一个、间隔至少 60 秒，不设等待上限，等的时间不算时限。
- 新规则 BR-2631（work/verify，新业务“项目声明的重命令”）：`canon heavy run -- <命令>`；配置 `heavy_commands`；负载超限时 Bash 前的 hook 拒绝匹配却没经过 `canon heavy run` 的命令。
- 提议改写（`canon/proposals/C-693/`）：BR-2526 第 2 条从 `cpu_light` 改成轻派发、轻改重的例外；BR-2581 去掉 `cpu_light`，写出轻派发个数和“还能轻派”；BR-2582 的 `heavy:` 一行加上等负载的步骤。
- 实现时：BR-2627 用 `canon rule retire` 退役；变更类型去掉内置字段 `cpu_light`（`src/knowledge/documents/`）；BR-2497（派发记录多轻重）、BR-2466 和 BR-2580（等负载不算时限）、BR-2045（新配置 `heavy_commands`、`design_profiles`）按新规则补文字；architecture.md 写上负载队列、`canon heavy run`、轻派发和能设计的 worker。

第二部分（D-162）：
- 新规则 BR-2633（work/delegation）：启动方设 `CANON_WORKER_PROFILE`、档案在 main 的 `design_profiles` 里的 worker 可以开变更和杂务，合入时不查 BR-2501 第 1 项；hook 拒绝命令里自己设这个变量。
- 提议改写 BR-2498、BR-2501 各加一句例外；BR-2495 的 hook 部分按 BR-2633 补。
- canon 之外：启动 worker 的工具（delegate）要设 `CANON_WORKER_PROFILE`。

总览不受影响：这次只写 planned 的规则和 proposed 的决定，系统还没变；architecture.md 由实现的合入一起改（见上一条）。

## 陷阱和假设

- 规则都是 planned；BR-2526、BR-2581、BR-2582、BR-2498、BR-2501 的新文字在提议里，实现的人合入代码时由设计负责人 `canon rule apply C-693`，不要在实现前应用（会让生效的规则说没做的事）。
- 负载队列放在用户状态目录下，和整组测试的 `full-runs/` 一样整机共用（BR-2576、BR-2577 的做法），不能放在某个仓库的协调数据库里。
- 整组测试先拿名额再等负载（BR-2630），顺序反了会在负载降下来后又等名额。
- 第二部分的防冒充只靠 hook 看命令文字，是已知限制（D-162 后果）。
- #304 里“只在分支上的设计也能派给能设计的 worker”不在本变更里。

## 教训

- worker 不能开变更，设计 worker 第一步就要停下等主会话开 → 由本变更的 BR-2633 解决（能设计的 worker 可以自己开）。
