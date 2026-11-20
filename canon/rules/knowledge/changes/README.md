# 变更的关联（knowledge/changes）

一个变更和别的东西的关联：属于哪个版本或功能模块、修哪些 GitHub issue、依赖哪些变更，以及依赖什么时候算满足（D-148、D-149）。关联写在变更文件自己的 front matter 里，只有这一份；由 `canon change new`、`canon work start --title`、`canon change link` 写入，不靠会话事后补。

不管：版本和模块本身（`knowledge/releases`）；变更执行哪些规则（`rules`，由合入写）；计划和步骤（`knowledge/plans`，D-148 之后逐步去掉）；待办顺序是负责人排的（`knowledge/documents`）；开工和列表的其余部分（`work/session`）。

分类：支撑领域。依赖是否满足每次从变更的状态算出，不另存。

依赖：`knowledge/documents`（读变更文件）、`knowledge/releases`（版本和模块是否存在）、`work/session`（只在分支上的变更）。

## 术语

- **关联**：变更 front matter 里的 `release` 或 `feature`、`issues`、`depends_on`，以及放弃的变更上的 `done_by`。
- **依赖满足**：被依赖的变更在 main 上已经合入（`done`），或被放弃时写明了由哪个已合入的变更做了；判定见 BR-2564。
- **当前这一批**：没写 `release` 也没写 `feature` 的未结束变更，等于 AI 会话自己定的交付范围，总览列给负责人看（BR-2505）。

## 业务

- **关联的写法**：变更 front matter 里关联的几个键怎么写，写错时 `canon check` 怎么报。
- **关联由命令写入**：新建、开工和之后修改时，哪些命令把关联写进变更文件，参数错了怎么拒绝。
- **依赖**：依赖什么时候算满足、没满足的变更怎样不被当作可开始，依赖成环怎样被拒绝，一个版本或模块的变更按依赖现算出的图。
