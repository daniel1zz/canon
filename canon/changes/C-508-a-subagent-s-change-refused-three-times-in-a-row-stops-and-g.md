---
id: C-508
title: A subagent's change refused three times in a row stops and goes to the
  main agent; the main session lets it land again (#195, D-99)
status: done
rules:
  - BR-2454
  - BR-2455
passes:
  BR-2340: 92b90ae79f1959d4 test
  BR-2454: 49afe1a81b963858 test
  BR-2455: d6def36201bf16eb test
---

## 为什么

负责人（canon human #34）：“还是保持之前那套把。然后三次没有合并成功再给主Agent”。D-99 定了做法；#195 记了同一个问题：子 agent 被拒后只会一轮轮重试，没有任何东西让它停下。

## 要改什么

- BR-2454：子 agent 认领的变更，自上次合入或放行以来被拒满三次（只数它能改或派活能避免的原因），第四次 `canon work land` 在入队前以 `stalled` 拒绝；第三次拒绝的信息就写明要停下报给主 agent。
- BR-2455：`canon work unstall <C-n> --reason` 由主会话或人放行，计数从零重来。
- 代码：`src/work/land/stall.ts`，`land.ts` 在写 `land.start` 前检查，`commands.ts` 加 `unstall`。
- canon-parallel 写明子 agent 被停下后怎么做；架构总览的合入流水线补上这一条。
- 合入后关闭 #195。

## 教训

无

## 任务

- [x] 规则
- [x] 代码和测试
- [x] skill 和总览
