---
id: C-558
title: A split rule review carries the documents its changed ones name in full
  only as far as they fit; the rest are listed by id, title and first line
  (#229)
status: done
rules:
  - BR-2488
  - BR-2359
passes:
  BR-2359: 886e2f936073858a test
  BR-2488: 8dc8f0fac17a88d4 test
---

## 为什么

#229：从 C-547（#219）起，拆开的规则评审每次调用都带改动文档点名的规则和决策全文。点名的文档一多，单单这部分就超过 `review_max_prompt_kb`；按改动文档再拆（BR-2448）也没用，因为一份文档自己就放不下。C-514 的合入后评审因此每次都以 `cannot be made smaller than 412 KB` 失败：它的 D-101 点名了 26 份文档，main 上这些文件一共约 169 KB。

## 要改什么

新规则 BR-2488，BR-2359 指向它：带上点名文档后放不下时，按点名先后能放全文的放全文，其余只列编号、标题和第一行，评审照常运行。代码在 `review.ts` 的 `reviewPrompts`（`namedInOrder`、`citedListed`）。budget.test.ts 里原来那个"点名文档算进拒绝的大小"的测试，换成了 BR-2488 的两个测试。

## 陷阱和假设

留给点名文档的空间，是按"这次评审要读的最大一块领域文字"预留的，和拆分时最大的那块是同一个量（reviewSizes 的 pieces），所以拆开后的每次调用都能放下。

## 教训

无
