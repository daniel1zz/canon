---
id: C-483
title: Raise review_max_prompt_kb to 300 so C-475's landing review fits; C-479
  sets it back to 250
status: open
rules: []
---

## 为什么

C-464 的 B 步前一半（C-475）把规则评审挪到合入之后，但它自己的合入仍由旧版 canon 在合入里评审。D-89 必须和它实现的规则同一次合入，这样提示最小的一次约 283 KB，超过 `review_max_prompt_kb` 的 250 KB，合入会被拒。负责人选择临时调大预算（canon human #28，选 A）。

## 要改什么

- `canon/config.yaml` 加一行 `review_max_prompt_kb: 300`，注释写明原因和由 C-479 改回 250。不改规则，不改代码。

## 教训

无

## 任务

- [x] 调大 `review_max_prompt_kb`
