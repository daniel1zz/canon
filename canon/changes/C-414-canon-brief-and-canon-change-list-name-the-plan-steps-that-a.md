---
id: C-414
title: canon brief and canon change list name the plan steps that are ready, so
  a coordinator sees what to dispatch
status: open
rules: []
---

## 为什么

#146 的第二片，C-412（计划的格式、检查、状态和 `canon plan status`）已合入，是这一片的基础；规则和决策见 BR-2369 到 BR-2374、D-77。

#146 里一个依赖早已合入的步骤几个小时没人派。C-412 之后协调者要主动运行 `canon plan status` 才看得到可开始的步骤；会话开始时 `canon brief` 和 `canon change list` 不提，仍然靠人想起来去看。

## 要改什么

- `canon brief` 在每个至少有一个可开始步骤的计划下提示：计划变更编号、计划的进度（已完成几步、百分比），和可开始的步骤名与内容。没有计划、或没有可开始的步骤时不输出这部分，其余输出不变。
- `canon change list` 的每个变更，在它做的步骤旁标出 `plan C-n step 名`；计划变更自己标出进度。
- 新规则（写在 `knowledge/plans`，也可以是 `work/session`，按它改的命令的领域定）：上面两条各一条规则，例子写进度提示的有与无、可开始的步骤已有变更在做（进行中）时不提示。
- 不做：自动给可开始的步骤开变更或派活；改 `canon plan status` 的输出（BR-2373、BR-2374）；计划属于版本（第 3 片）。

## 任务

- [ ] 规则、测试（`it("BR-n: ...")`）、实现
- [ ] `canon brief` 的输出长度检查：一个有 50 步的计划只多几行
