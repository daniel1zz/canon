---
id: C-433
title: human answer records the human's own words when they pick none of a
  question's options
status: done
rules:
  - BR-2021
  - BR-2276
  - BR-2075
passes:
  BR-2021: b38928e18591e161 test
  BR-2075: 345c65bb25e9f34e test
  BR-2276: 37d85499f63eac25 test wording
---

## 为什么

负责人 2026-11-09 指出：问题带选项时，canon 只接受选项内的答案。提问工具总会给人一个“Other”让人自己打字，人这样回答时，agent 用 `--relayed` 转述原话，`canon human answer` 以退出码 1（`option-mismatch`）拒绝，人的回答记不进 canon。复现：`canon human ask "发布吗？" --option "yes,no"` 后 `canon human answer 2 "先等 C-428 合入再发" --relayed "先等 C-428 合入再发"` → 退出码 1。负责人在提问工具里选了“原话照录 (推荐)”。

## 要改什么

- BR-2021：带选项的问题，原话按逗号分开后每个不为空的部分都是选项的，仍按选项检查（防止 no 记成 yes，C-341）；原话里有不是选项的部分，算自由回答，记录的回答必须和原话一字不差（只去首尾空白，区分大小写），`canon human pending` 标 `[not one of the options]`。
- BR-2276：括号里“回答要和原话是同一个选项”改成“回答和原话的关系由 BR-2021 检查”。
- BR-2075：处理 BR-2021 上 C-379 留下的评审建议，`ask --multi` 必须带 `--option` 这一条触发点在 ask，挪到 BR-2075；BR-2021 写明没有 `--multi` 的问题收到多个选项时原因也是 `option-mismatch`。
- `canon release ship`（BR-2331）只认 `yes`/`是`，自由回答不会放行发布，不用改。

## 教训

无

## 任务

- [x] 改 BR-2021、BR-2276
- [x] `answer()` 分出自由回答，pending 标记
- [x] 测试（含真实 CLI）
