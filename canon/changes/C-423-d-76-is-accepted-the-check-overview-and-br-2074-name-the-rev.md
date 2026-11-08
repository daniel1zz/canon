---
id: C-423
title: D-76 is accepted; the check overview and BR-2074 name the review-size
  hint and budget
status: done
rules: []
passes:
  BR-2074: a60b2a28e1bb3fd5 test
---

## 为什么

C-413 和 C-419 修了 #145：`canon check` 在某个顶层领域的规则评审提示接近 `review_max_prompt_kb` 时提示一行（BR-2375）。D-76 记下了这个做法，现在是 proposed。

D-76 已经经过独立评审：评审指出 80% 的提示线碰不到 #145 自己的例子（78%），C-419 已经按评审的意见改成 70%，并在 worktree 里按这次实际改动的文档来算。

C-419 的评审还留下两条没处理的提示：

- `knowledge/check` 的 README 还写“两种只提示的输出”，没有 BR-2375；
- BR-2074 列出取自 main 的评审设置时没有 `review_max_prompt_kb`，而代码一直是从 main 取的。

## 要改什么

- 接受 D-76。
- check 的 README 改成三种只提示的输出，加上 BR-2375。
- BR-2074 的取自 main 的设置里加上 `review_max_prompt_kb`（BR-2359）。这只是把代码已有的行为写进规则，不改行为，所以例子不变。

## 教训

无

## 任务

- [x] 接受 D-76
- [x] README 和 BR-2074 补齐
