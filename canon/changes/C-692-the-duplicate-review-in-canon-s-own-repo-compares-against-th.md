---
id: C-692
title: the duplicate review in canon's own repo compares against the guide of
  the reviewed tree, not the reviewer binary's (#290)
status: done
rules:
  - BR-2143
owner_gate: "none: 修 bug"
advances: "none: 修 bug"
passes:
  BR-2143: 28bffc55305c8480 test
---

## 为什么

GitHub #290：合入后的常驻说明重复评审（BR-2143）拿运行评审的 canon 程序里编译进去的工作说明做比较。canon 自己的仓库里 `dist/canon` 只在后台 floor 通过后才重建，常常落后于 main；一次改写工作说明某句的合入，被拿去和那句的旧文字比，评审就报“旧句和新句重复”（例如评审意见 #214）。

## 要改什么

- 被评审的树里有 `src/invocation/guide.ts`（canon 自己的源码）时，重复评审用 bun 从这棵树算出工作说明来比较；其他项目照旧用程序自带的那份。
- 算不出来时这次重复评审记为失败并写明原因，不悄悄退回旧的那份。
- BR-2143 写明这一条，加两个例子。

## 教训

无
