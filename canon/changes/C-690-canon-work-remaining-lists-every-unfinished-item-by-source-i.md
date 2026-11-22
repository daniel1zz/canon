---
id: C-690
title: canon work remaining lists every unfinished item by source in one command
  (#298)
status: open
depends_on: [C-689]
rules: [BR-2629]
owner_gate: "none: 负责人在对话里已选方向"
advances: "none: 汇报工具，不属于当前版本的成功标准"
---

## 为什么

GitHub #298：回答负责人“还差哪些没做”时，没有一条命令能列全。会话要拼 `canon change list`、`canon work due`、`canon progress`、`canon human pending` 等好几条，`canon overview` 只算当前版本，和 `canon progress` 的数字对不上；评审意见没有逐条列出的命令；“已接受的决定没有任何规则或变更引用”根本没有命令。2026-11-22 zhushenkongjian 的一次进度汇报因此漏了几类。负责人选了“新命令按来源列全”。

## 要改什么

- 新命令 `canon work remaining [--json]`（BR-2629）：六节，每节标题写条数——没关闭的变更、没通过的规则（全部，不只当前版本）、没关的评审意见（逐条）、待回答的问题（没回答、没撤回）、没有规则或变更引用的已接受决定；最后一行说项目 issue 要用项目自己的工具查。
- 第 6 节逐条对照：已接受决定的 `## 决定` 里没写到规则或变更编号的条目（负责人 2026-11-22 选了“加，默认只列最近的”）：默认只看 30 天内加入 main 的决定，`--all` 看全部，文字最多 30 行。
- overview 领域 README 加业务“未完成清单”。
- 依赖 C-689：待回答的问题按它的“没撤回”判断。

## 教训

无
