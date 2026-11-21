---
id: C-685
title: owner approval binds to the owner_gate text it approved (#296)
status: open
rules: []
owner_gate: "none: 修安全漏洞，行为由 BR-2616 规定"
advances: "none: 修 bug"
---

## 为什么

GitHub #296：负责人批准某个变更的关卡后，执行者再改 `owner_gate` 的文字（比如从“设计稿”改成“上线到生产”），`land --finish` 仍按旧的批准放行。批准只按变更编号匹配，没核对批准的是哪段文字，负责人要求的拦截可以被绕过。

## 要改什么

- 批准只认问的正是现在这段关卡文字的问题：`approve C-n: <owner_gate>?`，冒号后的文字去掉首尾空白和末尾问号后与 `owner_gate` 相同（BR-2616）。
- 只有问旧文字的回答时，拒绝信息和议程项（BR-2617）写出旧问题的编号和它问的文字，说要重新问。
- 合入、议程、委派提示三处都按现在的关卡文字判断。

## 教训

无
