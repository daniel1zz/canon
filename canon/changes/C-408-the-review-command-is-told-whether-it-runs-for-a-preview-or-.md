---
id: C-408
title: The review command is told whether it runs for a preview or for the landing
status: open
rules: [BR-2366]
---

## 为什么

#144：`canon work review` 和合入运行的是同一个评审命令，命令分不出是哪一种；项目想让预览用便宜的模型就做不到。

## 要改什么

- 新规则 BR-2366：评审命令的环境里有 `CANON_REVIEW_KIND`，合入是 `land`，预览是 `preview`（规则评审、重复评审、拆开的每次调用都一样）。
- `runReview` 的 `ReviewLimits` 多一个必填的 `kind`，没有默认值；`steps.ts` 传 `land`，`preview.ts` 传 `preview`。
- `review` 配置项的说明（配置参考）写明这个变量。
- 测试：`src/work/land/checks/review-kind.test.ts`。

## 陷阱和假设

合入后的代码评审（`after_land`）用的是另一个命令，不在这里。

## 教训

无

## 任务

- [ ] 规则、代码、测试
