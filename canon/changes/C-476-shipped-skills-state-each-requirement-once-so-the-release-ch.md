---
id: C-476
title: Shipped skills state each requirement once, so the release check
  publishes again (#189)
status: open
rules: []
---

## 为什么

main 的后台测试通过后，`bun scripts/release.ts`（BR-2411、BR-2412、D-91）对全部自带 skill 和 `canon brief` 的说明一起做重复评审。0851335ef 被 9 条重复意见拦下（#189），`dist/canon` 和 `dist/skills` 从那以后没有再发布，已合入的改进都卡着。

## 要改什么

只改 `.claude/skills/canon-*/SKILL.md`：每条要求只在一处写全，其余地方改成短指引，保留各 skill 自己补充的部分；不改 brief 的说明（另一个变更正在改它）。规则行为不变，不新增规则。

#189 的 9 条：

- 开 issue 的要求（一个根因、复现命令、期望和实际）只留在 brief；canon-diagnose、canon-test、canon-uat 只说用 `gh issue create`、按 brief 写。
- 不经管道读退出码只留在 canon-test 第 5 节第 6 条；canon-uat 指向它。
- canon-rules 反模式里删掉与第 1、3、6 节重复的四条；第 2 节表格里“边界值上发生什么”是写规则前问需求的问题，不是对例子的要求，保留。
- 决策列出全部方案和理由：通用结构只留在 canon-design 第 4 节；canon-rules、canon-prototype 指向它，canon-prototype 和 canon-triage 只保留自己的内容。
- canon-test 第 6 节不再复述 brief 里 `canon work test` 只跑相关测试、floor 合入时跑全套。
- “canon/ 下的文档用中文”：brief 没有这句，不能按意见“只留在 brief”；改为只在 canon-rules 第 6 节第 2 步写全，canon-design、canon-product 指向它，canon-prototype 经 canon-design 第 4 节指向它。

之后每次重跑 `bun scripts/release.ts --check` 都报出新的一批重复，一并处理：

- 一个根因一个 issue：canon-triage、canon-parallel 不再复述。
- 行为和规则同一提交：canon-rules 第 6 节第 5 步只说测试也在同一提交，canon-test 清单不再复述。
- 测试按规则命名只留在 brief，canon-test 第 4 节只留自己的补充，其他 skill 不再写 `it("BR-n: ...")`。
- 向人提问的范围只留在 brief，canon-rules 第 5 节只补“产品手感”；“不依赖答案的工作继续”由 brief 的“do not wait for them on anything else”和 `canon human ask` 的命令说明表达，skill 不再复述（canon-domains 指向它的半句一并删掉）。
- canon-test 第 7 节清单、canon-product 退出清单改成指回原节（“没跑的实验也要报”并入 canon-product 第 5 节）。
- 拒绝的测试方式只留在 canon-test 第 4 节；先见红只留在 canon-test 第 3 节（并入“继承的测试集先变异一处”）；从规则推期望只留在第 1 节第 2 步；`untested` 只留在 canon-rules 第 6 节第 5 步；“断言外部可观察结果”只留在 canon-test 第 4 节。
- canon-prototype：原型代码并入方式只留在第 5 节；第 4 节说的是谁选赢家（新界面用哪种结构），第 3 节说的是改现有界面结构前先问。
- 子 agent 交回选择只留在 canon-parallel 第 3 节；清理工作树只留在 canon-parallel 一条；以事件表为准只留在第 5 节；退出码 75 的处理只留在 brief。
- 继承旧笔记和决策只留在 canon-design 第 2 节；canon-triage 查已有决策只留在第 1 节。
- canon-triage 第 4 节、canon-design 第 4 节第 5 步不再复述 brief。
- 第 8 到 14 轮：canon-triage 已知限制的条件只留在第 2 节、“完成”清单改成指回原节、读取凭据的要求指向 canon-secrets；canon-parallel“互不依赖”只留一处、规则准备只留在第 3 节、决策质询指向 canon-design 第 3 节；canon-rules 1a 不再复述“引用共享行为”、第 6 节第 7 步不再复述 `canon check`、第 4 节“一条规则一个行为”指向 brief；canon-product 中 `unvalidated` 进入提问只留在第 5 节第 2 步、委托的选择指向 canon-design 第 4 节；canon-design 第 2 节只补“同时更新受影响的决策”；canon-test 第 5 节第 4 条按第 2 节判断静默回退；canon-uat H2 不再复述 UNVERIFIED 不能算通过；canon-diagnose 第 5 阶段先见红指向 canon-test 第 3 节。

## 教训

- 发布前的重复评审每次只报出一部分重复：按 #189 的 9 条改完后又跑了 13 轮，每轮报出新的 1 到 6 条（同一处有时判为提示、有时判为拦截），第 14 轮才通过 → 待负责人确认是否固化（例如让评审一次列出全部重复，或在 `canon work review` 里对改了 skill 的变更先跑同一个检查）。
- 评审建议的修法可能引用 brief 里并不存在的话（“canon/ 文档用中文只留在 brief”）→ 只靠文字：评审是模型判断，照做之前要自己核对原文。

## 任务

- [x] 按 #189 的意见精简 skill
- [x] `bun scripts/release.ts --check` 通过
