---
id: C-475
title: The rule and duplicate reviews run after landing, blocking findings are
  verified and recorded, and landing no longer waits for them (C-464 B)
status: open
rules:
  - BR-2009
  - BR-2010
  - BR-2014
  - BR-2022
  - BR-2074
  - BR-2143
  - BR-2145
  - BR-2057
  - BR-2163
  - BR-2166
  - BR-2167
  - BR-2172
  - BR-2173
  - BR-2216
  - BR-2239
  - BR-2296
  - BR-2310
  - BR-2358
  - BR-2359
  - BR-2361
  - BR-2366
  - BR-2367
  - BR-2375
  - BR-2396
  - BR-2405
  - BR-2407
  - BR-2410
  - BR-2441
  - BR-2442
---

## 为什么

C-464 的 B 步（D-89）：zhushenkongjian 约 65% 的合入被拒来自规则评审，抽查的拦截意见里误报 57%；负责人（canon human #20 选 B）决定迭代中评审不拦合入，一致性在验收时保证。这个变更是 B 步的前一半（B1）：评审离开合入、改在合入后后台运行，拦截意见核实后记账。

## 要改什么

- 合入不再跑规则评审和重复评审，也不再因没配评审命令被拒（D-51 被 D-89 修改）；合入里只剩措辞判断（BR-2239）一次模型调用：只带 `# Wording judgements` 的提示，判断记成 `review.wording`，同样的问题判过就沿用。理由：措辞记录要在关闭提交进 main 之前确认，这是最小的安全做法；改成一律要测试或验收证据会让只改措辞的规则多出无意义的测试改动。
- 合入成功后把要评审的合入排进协调数据库的 `landed_reviews`，后台 `canon work review-landed` 一次运行一个（BR-2441）；设置取自合入前的 main（BR-2074），评审命令在那个提交的临时 worktree 里运行，文档从合入的提交的临时 worktree 读；BR-2361、BR-2396 的沿用和小评审照旧用在合入后的评审上。
- 新配置键 `review_verify`：拦截意见逐条核实，成立的和没核实的按 A 步记账，被否定的只留在评审事件的 `verified` 里（BR-2442）。
- 建议改从合入后评审的事件读（BR-2145）；`canon work after-land` 报告同一次合入的评审，`--wait` 等它并在没有评审进程时启动一个。
- 改写 knowledge/review 下说评审在合入里、拦截合入的规则；退役 BR-2295。
- 接受 D-89（D-87 随之 superseded），C-456 的计划一节改名、`canon plan status` 不再提供它；改架构总览。D-89 不接受，这里的规则就和已接受的 D-51、D-87、D-19 矛盾（预览评审的拦截意见），所以必须同一次合入。
- 这次的测试点名的 work 和 invocation 规则一起改：BR-2014（评审不是合入的步骤）、BR-2163（`--finish` 的输出）、BR-2166、BR-2167（after-land 报告和等待评审）、BR-2310（找不到时的信息）、BR-2407（密钥扫描拒绝时不排评审）、BR-2022（退出码 1 的情形）。
- 不在这个变更里（B 步的后一半 B2，`--plan C-464 --step B`）：work 领域其余说评审是合入步骤的规则（BR-2172、BR-2173、BR-2106 等）和 install、query、documents、check 里顺带提到合入时评审的几处措辞；对未处理意见的逐条复问（`closeNoLongerHolds`）；`canon verdict` 判合入后评审的意见；`canon stats` 按标准统计核实结果。
- 合入前另有一个小变更先合入：几份决策的来源引文改成评审挪到合入后前后都成立的文字，否则这里改了代码和规则，它们的引文就对不上。

## 陷阱和假设

- 这一次合入没有经过合入里的规则评审：负责人决定（canon human #29，选 B）用这个变更自己的版本合入（`bun src/invocation/main.ts work land --finish`），因为旧版合入里评审的提示放不下（拿掉其余过时规则后最小一次约 327 KB，超过 `review_max_prompt_kb` 300），每次尝试又要用完一整轮评审额度。它的规则和决策改动由合入后的评审（BR-2441）评审，核实成立的意见记成未处理的意见。
- 拆开合入的原因：这个变更自己的合入仍由旧版 canon 在合入里评审，提示里改动文档的部分不能超过 `review_max_prompt_kb`（250 KB）减去固定部分和领域正文，约 176 KB；全部放在一起约 235 KB，合入会被拒。决策引文已经先单独合入（C-478）。D-89 的接受必须和这里的规则同一次合入；负责人先选调大预算（canon human #28），之后剩下的过时规则也必须一起改，仍放不下，改为下面这条。
- 测试里 `CANON_LANDED_REVIEWER=0` 让合入只排队、不启动后台进程，由测试自己运行 `runLandedReviews`，避免测试留下后台进程。
- `review_verify` 是新键，按 BR-2248 不能在同一次合入里写进 canon/config.yaml；要启用就在之后单独合入。

## 教训

- 一次改写大量规则的变更会让旧版 canon 在合入里的评审因提示超过预算被拒，只能拆变更 → `canon check` 的 `hint review-size` 已经提前提示（BR-2375），这次就是它提示的；只靠文字：要不要拆、怎么拆取决于内容，canon 判断不了。

## 任务

- [x] 合入里去掉规则评审和重复评审，只留措辞判断
- [x] 合入后评审的队列和后台进程、核实命令、记账
- [x] after-land 报告、建议的来源
- [x] knowledge/review 规则
- [x] 测试
