---
id: C-462
title: The downstream duplicate review never blocks on the skill files canon ships
status: open
rules: [BR-2410, BR-2143]
---

## 为什么

下游项目运行 `canon update` 时，canon 的每个 skill 一起变，重复评审（BR-2143）把它们都当作这次合入改动的常驻说明，canon 自己 skill 之间的重复就拦下这个更新变更；项目又改不了 canon 的文件（改了下次更新要 `--force`）。#159、#182 两次出现。负责人选了方案 B（canon human #23）：canon 发布前在自己仓库全量评审，下游合入时不评审 canon 装进来的文件。本变更做后一半。

## 要改什么

- 新规则 BR-2410：清单（`.claude/skills/.canon-skills.json`）列出、内容哈希和清单一致的 skill 文件不算改动过的常驻说明；只改了这些时不做重复评审；它们的 description 仍作为对照列在提示里，标 `(shipped by canon)`，项目自己的文字和它们重复时照常拦截。项目改过的、清单没列的照常评审；清单坏了全部照常评审。
- BR-2143 加一句指向 BR-2410。
- 代码：`src/install/install.ts` 的 `shippedUnedited`；`standingTouched` 去掉这些文件；`standingText`、`duplicatePrompt` 标出它们。
- 不在范围内：canon 发布前的全量评审，另开变更。

## 陷阱和假设

- canon 自己的仓库也有清单（`canon update` 在 worktree 里写过）；在这里改过的 skill 哈希和清单不一致，照常评审，不需要特判。

## 教训

- 下游更新变更被 canon 自己 skill 之间的重复拦下，项目没法修 → 现在由 BR-2410 保证（负责人已选方案，canon human #23）

## 任务

- [x] 写 BR-2410，改 BR-2143
- [x] 代码和测试
