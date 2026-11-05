---
id: C-379
title: human answer accepts multi-select answers
status: done
rules:
  - BR-2021
passes:
  BR-2021: 0a6196f22a4bbcae test
---

## 为什么

Fixes #130：负责人在提问工具里多选时，`canon human answer` 只接受单个选项，答案记不进 canon。

## 要改什么

`canon human ask --multi`（只能和 `--option` 一起用）把问题记成多选；`canon human answer` 对多选问题接受选项的子集（逗号分隔，同提问工具格式），仍按选项和提问工具记录检查。questions 表加 `multi` 列。修改 BR-2021。

## 教训

无

## 任务

- [x] 改 BR-2021
- [x] 加 multi 列、`--multi`、答案检查
- [x] 测试（含真实 CLI）
