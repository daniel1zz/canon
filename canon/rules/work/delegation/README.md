# 派发（work/delegation）

主会话把一个变更交给 worker（子 agent，或 delegate 之类的工具启动的 worker 会话）去执行时，canon 记下谁定设计、按哪个设计版本执行，worker 碰到没定的设计怎样交回，设计负责人怎样收回（D-128）。设计（决策、规则、产品承诺、发布范围、项目声明的设计文件）只由设计负责人写；worker 在派发时固定的设计版本里实现，自己合入。

不管：worker 合入时对设计文档的检查（work/land/checks，BR-2501）、评审意见由谁处理（knowledge/review/findings，BR-2502）、合入后代码评审对 worker 合入的额外检查（knowledge/review，BR-2503）。

## 业务

- **派发记录**：主会话把变更派给哪个 worker，设计负责人是谁，派发时 main 的哪个提交是设计版本。
- **worker 的认领范围**：worker 能认领哪些变更。
- **交回设计**：worker 碰到没定或矛盾的设计时怎样交回设计负责人，回答怎样回到 worker。
- **收回派发**：设计负责人怎样收回派出去的变更。

## 术语

- **worker**：执行者带名字一级的会话，即 `agent:<会话>:<名字>`（`--as <名字>` 或 `CANON_SUBAGENT`，BR-2023、BR-2495）。
- **设计负责人**：运行 `canon work delegate` 把变更派出去的执行者；它不是 worker。
- **设计版本**：派发时 main 的提交；worker 按这个提交上的契约清单执行。
- **契约清单**：派发时固定的、约束这个变更的设计文档清单和各自的内容哈希（BR-2497）。
- **代次**：派发每次创建、重新派发、被 `take` 都加 1；带着旧代次的认领合入不了（BR-2501）。
- **接受者**：第一个认领这个派发的 worker 执行者；同名的另一个会话不算。
- **设计文档**：`canon/decisions/`、`canon/rules/`、`canon/product.md`、`canon/releases/`、`canon/config.yaml`、`canon/backlog.md`、变更文件的 `## 为什么` 和 `## 要改什么` 两段，以及 main 上配置 `design_paths` 列出的路径。
