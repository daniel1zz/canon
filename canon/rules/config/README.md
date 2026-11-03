# 配置与扩展（config）

`canon/config.yaml` 的读取和校验，以及项目扩展 canon 的四种方式（D-2、D-3）：策略参数、文档类型、生命周期 hook、文档模板。租约、掉线、排队超时这些参数各自的行为写在 work 领域的规则里，这里只管配置本身怎样读、怎样报错，以及类型、hook、模板的行为，和代码目录与规则领域怎样对应（`code_root`、`shared`，D-15）。类型声明的读取和校验属于这里；文档类型的模型本身（内置的四种类型、编号的格式）属于 `knowledge/documents`。

配置项不集中登记：每一项（名字、类型、默认值、校验、说明）由用它的领域在自己代码目录的 `config-keys.ts` 里声明，`src/config/config.ts` 只把它们组装起来、按顺序校验，只有新增领域时才改；类型、hook、模板、`code_root` 和 `shared` 这几项属于本领域，声明在 `src/config/config-keys.ts`。

## 术语

- **声明的类型**：项目在 `types:` 下声明的文档类型，有自己的编号前缀、目录和状态；内置的规则、决策、变更、笔记不能删除，只能加必填字段。
- **hook**：在 `after_start`、`before_land`、`after_land`、`after_stop`、`after_green`（BR-2222）五个事件上运行的命令；只有 `before_land` 能拒绝合入。
- **共享代码**：`shared` 列出的、不属于任何业务领域的代码（共享内核）。
- **模板**：`canon/templates/<类型名>.md`，新建文档时的初始正文。
