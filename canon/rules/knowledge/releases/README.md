# 版本（knowledge/releases）

按版本逐步开发时，一个版本是什么、包含哪些规则、能不能发：版本文档（`canon/releases/R-n.md`，版本的 PRD）、规则上的 `release` 标签、版本的检查、进度和发布快照（D-61）。

不管：规则本身怎么写、怎么检查，由 `knowledge/documents` 和 `knowledge/check` 负责；规则的执行状态（已通过、待重新执行）由 `work/execution` 算出，这里只按版本分组；发布时问负责人的问题由 `work/humans` 记录。

分类：支撑领域。基线仍然是 `canon/rules` 一份，版本只是给它加的一层标签和记录。

依赖：`knowledge/documents`（文档的读写和编号）、`work/execution`（执行状态）、`work/humans`（负责人的回答）。

## 业务

- **版本文档**：一个版本是一份带六节的文档：怎么建、怎么列、它有哪几种状态。
- **规则属于哪个版本**：规则和计划变更用 front matter 的标签说明自己属于哪个版本、在哪个版本改过，格式怎么算对，读的时候在哪看得到。
- **版本的进度**：`canon release status`：一个版本现在做到哪了，按它的规则的执行状态算出来。
- **发布**：`canon release ship`：满足什么条件才允许发布、发布这件事本身怎么落到仓库里。
- **发布之后冻结**：已经发布的版本，哪些内容从此不许再改。

## 术语

- **版本**：产品的一个发布节点，如 MVP、v1，存为 `canon/releases/R-n.md`，状态 `planned`（规划中）、`active`（进行中）、`shipped`（已发布）。不同于 git 的 tag：版本带目标、范围和状态，tag 只指向一个提交。
- **版本文档**：版本的 PRD，必有六节：目标、用户、范围、不做、成功标准、故事地图切片。
- **标着某版本的规则**：front matter 里写了 `release: R-n` 的规则，`R-n` 是引入这条行为的版本；之后的版本改了它的行为，另写 `changed_in: [R-m]`。没写 `release` 的规则不属于任何版本。
- **发布快照**：版本发布时 main 的提交号，写在版本文档的 `shipped_at` 里；文档里的提交号是准的，git tag `release/R-n` 只是方便。
