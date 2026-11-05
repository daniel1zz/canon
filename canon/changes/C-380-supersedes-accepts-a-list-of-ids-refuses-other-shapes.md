---
id: C-380
title: supersedes accepts a list of ids, refuses other shapes
status: open
rules: [BR-2027, BR-2230]
---

## 为什么

Fixes #131。决策的 `supersedes` 写成 YAML 列表时被静默丢掉：`canon decision accept` 不取代任何决策，`canon check` 也不报。`amends` 是列表，`supersedes` 很容易写成同样的形状。

## 要改什么

`supersedes` 接受一个编号或编号列表；其他形状（数字、映射、空列表、含非编号元素）读文档时记为问题，`canon check` 报文件和字段，`canon decision accept` 退出码 1 且不改文件。所有读 `supersedes` 的地方（accept、check、总览检查、规则评审提示、查询）都按列表处理。修改 BR-2027 和 BR-2230。

## 教训

无

## 任务

- [x] 读取、accept、check、总览检查、评审提示、查询都按列表处理
- [x] 改 BR-2027、BR-2230
- [x] 加命令行测试和各读取处的测试
