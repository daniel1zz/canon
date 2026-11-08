---
id: C-424
title: canon backlog urgent marks a change queued with land --finish, which is
  done on its branch but not yet on main (#153)
status: open
rules: []
---

## 为什么

#153：`canon backlog urgent` 拒绝所有用 `canon work land --finish` 排着队的变更，信息是“is done, not open”，所以负责人的优先给不到真正需要它的变更。复现：变更只在自己分支上、分支上的变更文件是 `status: done`（`--finish` 在排队前写的关闭提交），对它执行 `canon backlog urgent`，退出码 2。原因：判断“能不能合入”只看状态字段是不是 `open`，而 `--finish` 让变更从排队到合入这段时间在分支上一直是 `done`。

## 要改什么

- BR-2363：“开着的变更”改成“还能合入的变更”：main 上 `open`；或只在自己分支上、`open` 或 `done`。main 上 `done`、`dropped`，或分支上 `dropped`，仍然拒绝，退出码 2；拒绝信息说它不能合入。
- 代码里两处 `// reason:` 和文档注释错引了 BR-2375，改成 BR-2363。
- 不做：按排队条目判断；`--clear` 的行为不变。

## 教训

无

## 任务

- [x] BR-2363 的规则和例子
- [x] 测试 `BR-2363: a change closed on its own branch by land --finish ...`
- [x] 实现
