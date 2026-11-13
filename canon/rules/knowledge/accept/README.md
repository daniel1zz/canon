# 验收（knowledge/accept）

负责人随时对 main 的当前提交发起验收：代码测过、文档一致、每条评审意见有处置、引用没有可疑的，全部成立才把 `refs/canon/accepted` 移到这个提交；发版发布已验收的提交（D-89）。这里只管验收这一个关口；各项条件本身由它们自己的领域定义（floor 在 work/land，评审意见在 knowledge/review/findings，可疑引用在 knowledge/links）。

## 术语

- **验收**：对一个提交确认 D-89 的全部条件成立，并记录在 `refs/canon/accepted`。
- **待负责人裁决**：一条未处理的意见有未回答的裁决问题（BR-2461 的 `question` 列）。

## 业务

- **验收**：`canon accept` 查什么、按什么顺序、通过和不通过各输出什么、`refs/canon/accepted` 怎么移动。
