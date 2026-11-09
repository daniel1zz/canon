---
id: C-442
title: canon human ask refuses --option given more than once instead of
  recording no options (#169)
status: open
rules:
  - BR-2382
---

## 为什么

#169：`canon human ask "Q?" --option yes --option no` 退出码 0，问题却没有任何选项（存成空列表），回答时也就不做 BR-2021 的选项检查。根因不在 `human ask`：命令行解析把重复给出的字符串选项变成数组，各命令读到数组的结果各不一样。实测：`--option` 两次 → 选项全丢；`canon decision new --title A --title B` → 标题变成 `A,B`；`canon search brief --limit 1 --limit 2` → 报一条看不懂的错（`got ["1","2"]`）。

## 要改什么

- 新规则 BR-2382：同一个字符串选项在一行命令里给了不止一次（两种写法、别名都算同一个），以退出码 2 拒绝，写明是哪个选项，提示多个值用逗号放在一个值里；命令不运行。布尔选项重复不管；字符串选项后面紧跟的词仍是它的值（BR-2228）。
- 在参数检查（BR-2097 的同一处）里做，所有命令一起生效。

不做：不让字符串选项接受重复给出来表示多个值。

## 教训

无

## 任务

- [x] BR-2382
- [x] 参数检查拒绝重复的字符串选项
- [x] 测试（含真实 CLI：`human ask`、`decision new`）
