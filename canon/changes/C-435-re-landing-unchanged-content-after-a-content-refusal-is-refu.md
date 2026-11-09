---
id: C-435
title: Re-landing unchanged content after a content refusal is refused at once,
  without waiting a queue turn (#154)
status: done
rules:
  - BR-2068
  - BR-2388
  - BR-2067
passes:
  BR-2067: 48034a4fe4dac636 test
  BR-2068: 4bc583b75afc60a7 test
  BR-2388: 324fa95a5e9a59b0 test
---

## 为什么

#154（#164 是同一根因，已作为重复关闭）：变更因自身内容被拒绝（canon check、hook、证据、规则评审）后，什么都不改再执行 `canon work land`，仍要排一整轮队，再被同样的原因拒绝一次。合入在入队前不看这个变更上一次拒绝记下的内容；检查内容的步骤只在轮到它时才跑。队列忙时一轮要几十分钟。

## 要改什么

- 合入因 `canon check` 被拒时，`land.refuse` 记下内容树和 rebase 到的 main。
- 入队前：这个变更最近的合入事件是这样的拒绝，并且内容树和 main 都没变，就当场重跑 `canon check`（测试报告、其他分支、待办清单按现在的读）：还有发现就立即拒绝（原因 `check`、退出码 1，带 `repeat_of`），没有了就照常入队。
- 只对 `check`：来源核对要联网、规则评审要调模型、版本检查要读负责人的回答，同样的内容结果可能不同，照常入队（第一版想照搬上次的结论，评审指出“缺测试报告”补上后内容不变、会被错误地一直拒绝，改成当场重跑）。
- 新增 BR-2388；BR-2067、BR-2068：带 `repeat_of` 的拒绝不算新的运行和拒绝；BR-2155 的并发摘要照常计数。

不做：不因为 `canon work review` 预览给出 block 就拒绝入队（#164 讨论过）；不改评审复用（D-70，见 #170）。

## 教训

无

## 任务

- [x] 新规则 BR-2388（work/land），改 BR-2068
- [x] 入队前比对上次拒绝
- [x] 测试：同内容再合入立即拒绝；main 前移后照常入队；floor 失败后照常入队
