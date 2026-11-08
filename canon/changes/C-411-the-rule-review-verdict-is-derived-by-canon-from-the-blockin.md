---
id: C-411
title: The rule review verdict is derived by canon from the blocking criterion
  each finding names, so a finding that matches a criterion cannot pass as a
  note (#147)
status: done
rules:
  - BR-2367
  - BR-2216
passes:
  BR-2216: f46cd15aa7b088f7 test
  BR-2367: c357da7acdde3488 test
---

## 为什么

#147：同一份提示发给同一个评审模型，结论在拦截和通过之间摇摆；通过的那几次里，同一个问题常常还在，只是写成不拦截的建议。根因：结论是评审在意见之外做的一次整体判断，canon 看不出一条意见是否符合提示里列的拦截标准。复现（从代码路径，没有调用模型）：评审命令输出 `{"verdict":"ok","findings":["D-66 changes part of D-21 without listing it in amends: ..."]}`，今天通过。

## 要改什么

- 现在：结论只取评审自己写的 `verdict`。之后：提示里每条拦截标准有短名字，评审的每条意见写明点名哪条标准或 `note`，canon 推出结论，有任何一条点名标准就拦截。
- 旧格式（只有 `verdict` 加字符串意见）有明文兼容规则，结论仍取 `verdict`；新格式里意见写错是无效结论，不猜（D-74）。
- 新规则 BR-2367；BR-2216 的结论格式一句改为指向它。规则评审的提示、重复评审的提示、`review` 配置键的说明和有关测试跟着改。
- 新决定 D-74（proposed）：真实方案对比，含否决的“再问一次”“调用两次”“只改提示”。
- 不在范围内：合入时再问一次、调用两次、判定命令和统计的格式（不变）。

## 陷阱和假设

提示变了，复用键（BR-2361）都变，升级后第一次评审会重新调用评审命令。

## 教训

无

## 任务

- [x] 规则和决定
- [x] 解析和推导、提示、测试
