---
id: C-428
title: A change learns which open changes touch the same files while it is being
  worked on, not only at landing (#156)
status: open
rules:
  - BR-2394
  - BR-2395
---

## 为什么

#156：两个会改同一批文件的变更可以同时开工、各做各的，重叠要到合入时才发现（`overlap.notice`、排队时预测冲突），那时两边都做完了，后合入的冲突，或者它测过的测试文件被改掉（#152）。zhushenkongjian 一天约 130 次拒绝里 37 次是冲突。BR-2062 在 `canon work start` 时已经比对各分支改过的文件，但新变更这时还没有改动，比不出东西；BR-2063 让 `canon brief` 显示重叠，可会话一般只在开头读一次 brief。

## 要改什么

- `canon work test` 开始时，按 BR-2062 的同一判定，对当前变更和每个别的进行中变更改了同一文件的情况各输出一行（和 BR-2063 的写法一样）。`canon work test` 是变更做到一半、合入前一定会跑的命令，这时当前变更已经有改动，比得出来。
- `canon work start` 开新变更时，列出进行中、分支上已有改动的变更和它们改动的地方（目录最多取前两级，每个变更一行，最多 10 行），让开工的人知道别人在动哪里；这不是重叠判定，只是告知。
- 新规则 BR-2394（开工时列出别的变更在改哪些地方，目录最多取两级）、BR-2395（`canon work test` 说出重叠，不写事件），例子写有重叠、没有重叠、git 出错时（和 BR-2063 一样不报错）。
- 不做：重叠时拒绝开工或拒绝测试（issue 提的项目配置开关，先看提示有没有用）；从变更文件文字猜它会改哪些文件。

## 教训

无

## 任务

- [x] BR-2394：`canon work start` 列出进行中变更改动的地方
- [x] BR-2395：`canon work test` 开始时说出重叠
- [x] 测试（`src/work/session/brief.test.ts`、`src/work/verify/verify.test.ts`）
