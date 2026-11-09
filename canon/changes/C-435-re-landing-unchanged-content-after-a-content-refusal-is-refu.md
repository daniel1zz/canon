---
id: C-435
title: Re-landing unchanged content after a content refusal is refused at once,
  without waiting a queue turn (#154)
status: open
rules:
  - BR-2068
  - BR-2388
---

## 为什么

#154（#164 是同一根因，已作为重复关闭）：变更因自身内容被拒绝（canon check、hook、证据、规则评审）后，什么都不改再执行 `canon work land`，仍要排一整轮队，再被同样的原因拒绝一次。合入在入队前不看这个变更上一次拒绝记下的内容；检查内容的步骤只在轮到它时才跑。队列忙时一轮要几十分钟。

## 要改什么

- 入队前：这个变更上一次合入被拒绝的原因只由变更内容决定（`check`、`source`、`release`、`review`；before_land hook 跑的是项目命令，可能不稳定，不算），并且现在的内容树和当前 main 都和那次被拒时相同（main 相同、内容相同，rebase 后的树就相同），就立即以同样的退出码拒绝，信息写明“和 <时间> 那次拒绝的内容相同，没有任何变化”，并说明那次的原因，不占队位，记一条拒绝事件。
- 规则评审被拒的也一样：内容和 main 都相同，评审提示就相同。
- 不算的拒绝：冲突、floor 失败、超时、main 移动、被别人认领，这些可能在 main 变了之后就通过，照常入队。
- 内容变了（分支多了提交，或 main 前移让 rebase 后的树不同）照常入队。
- 新增 BR-2388 写上面的条件和两侧例子；改 BR-2068：立即重复的拒绝（带 `repeat_of`）不算新的拒绝。

不做：不因为 `canon work review` 预览给出 block 就拒绝入队（评审模型结果不稳定，旧的 block 会把变更锁死，#164 里讨论过）；不改评审复用本身（D-70）。

## 教训

无

## 任务

- [x] 新规则 BR-2388（work/land），改 BR-2068
- [x] 入队前比对上次拒绝
- [x] 测试：同内容再合入立即拒绝；main 前移后照常入队；floor 失败后照常入队
