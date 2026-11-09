---
id: C-435
title: Re-landing unchanged content after a content refusal is refused at once,
  without waiting a queue turn (#154)
status: open
rules: []
---

## 为什么

#154（#164 是同一根因，已作为重复关闭）：变更因自身内容被拒绝（canon check、hook、证据、规则评审）后，什么都不改再执行 `canon work land`，仍要排一整轮队，再被同样的原因拒绝一次。合入在入队前不看这个变更上一次拒绝记下的内容；检查内容的步骤只在轮到它时才跑。队列忙时一轮要几十分钟。

## 要改什么

- 入队前：这个变更上一次合入被拒绝的原因只由变更内容决定（check、hook、证据、规则评审），并且把它 rebase 到当前 main 后的树和那次被拒时的树相同，就立即以同样的退出码拒绝，信息写明“和 <时间> 那次拒绝的内容相同，没有任何变化”，并说明那次的原因，不占队位，记一条拒绝事件。
- 规则评审被拒的，用 BR-2361 的提示键比较（键在 rebase 后才有，所以比的是 rebase 到当前 main 后的树）。
- 不算的拒绝：冲突、floor 失败、超时、main 移动、被别人认领，这些可能在 main 变了之后就通过，照常入队。
- 内容变了（分支多了提交，或 main 前移让 rebase 后的树不同）照常入队。
- 新增一条规则写上面的条件和两侧例子；改 BR-2068 对 `same` 一类的说明。

不做：不因为 `canon work review` 预览给出 block 就拒绝入队（评审模型结果不稳定，旧的 block 会把变更锁死，#164 里讨论过）；不改评审复用本身（D-70）。

## 教训

无

## 任务

- [ ] 新规则（领域按 `canon rule domains` 选 work/land 下合适的子领域）
- [ ] 入队前比对上次拒绝
- [ ] 测试：同内容再合入立即拒绝；main 前移后照常入队；floor 失败后照常入队
