---
id: C-416
title: canon plan link adds a plan and steps to a change that is already started
status: done
rules:
  - BR-2389
passes:
  BR-2389: 44aadc41d90bd842 test
---

## 为什么

#146 的第四片，C-412 已合入，是这一片的基础；规则和决策见 BR-2371、BR-2376、D-77。

C-412 的“后果”写明：做步骤的变更只有 front matter 里有 `plan` 和 `steps`，步骤才会显示进行中。已经开工的变更（C-412 之前开的，或者用 `canon work start` 不带 `--plan` 开的）要手改 front matter，忘了改的步骤会显示成可开始，可能被重复派。

## 要改什么

- 新命令 `canon plan link <C-n> --plan C-m --step 名[,名]`：给一个已经存在、状态是 `open` 的变更写上 `plan` 和 `steps`（在它自己的 worktree 或分支里改，和别的写文档的命令一样走变更的流程），检查和 `canon work start --plan --step` 一样：计划有效、步骤存在（BR-2376 的检查提成共用的函数）。已经有 `plan` 的变更再链接时拒绝（退出码 5），要换要手改。
- 不做：自动按标题或内容猜该链接哪一步（D-77 否决）；迁移项目里已有的别的格式的计划（要改成 `## 计划` 表，改的是各项目自己的变更文件，canon 不猜）。

## 教训

无

## 任务

- [x] 规则 BR-2389（例子：成功、计划无效、步骤不存在、已经有 plan、变更不是 open、不在这个 checkout）
- [x] 测试、实现（开工和链接共用 planProblem）
