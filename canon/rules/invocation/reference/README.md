# 配置参考（invocation/reference）

让人和 agent 看到 `canon/config.yaml` 能设置什么、现在设成什么，以及编辑时得到补全和错误提示（D-28）。只管“看”和“编辑提示”；配置怎样读、写错时怎样失败属于上一层 `invocation`（BR-2045），每个配置项的行为写在用它的领域里。改配置和改别的文件一样走合入，这里不提供绕过合入的修改方式。

## 术语

- **配置项**：`canon/config.yaml` 的一个顶层键，由用它的领域声明名字、说明、默认值和 schema 片段。
- **schema**：描述 `canon/config.yaml` 的 JSON Schema（draft-07），由当前运行的 canon 生成，编辑器据此补全键名、显示说明、标出写错的值。
- **`.canon` 目录**：仓库根目录（每个 worktree 各一个）下由 canon 生成、被 git 忽略的文件，可以随时重建。
