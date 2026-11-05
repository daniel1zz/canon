# 配置与扩展（config）

`canon/config.yaml` 的读取和校验，以及项目扩展 canon 的四种方式（D-2、D-3）：策略参数、文档类型、生命周期 hook、文档模板；其中文档类型和模板的规则在 `knowledge/documents`。租约、掉线、排队超时这些参数各自的行为写在 work 领域的规则里，这里只管配置本身怎样读、怎样报错，以及类型、hook、模板的行为，和代码目录与规则领域怎样对应（`code_root`、`shared`，D-15）。文档类型（声明的读取和校验、模板、必填段落）属于 `knowledge/documents`（D-63）。

配置项不集中登记：每一项（名字、类型、默认值、校验、说明）由用它的领域在自己代码目录的 `config-keys.ts` 里声明，`src/config/config.ts` 只把它们组装起来、按顺序校验，只有新增领域时才改；hook、`ports`、`code_root` 和 `shared` 这几项暂时仍声明在 `src/config/config-keys.ts`；类型和模板的声明在 `src/knowledge/documents/config-keys.ts`。

## 术语

- **hook**：在 `after_start`、`before_land`、`after_land`、`after_stop`、`after_green`（BR-2222）五个事件上运行的命令；只有 `before_land` 能拒绝合入。`after_green` 的命令必须能重复运行，以 `CANON_GREEN` 为准（BR-2222）。
- **共享代码**：`shared` 列出的、不属于任何业务领域的代码（共享内核）。
- **变更的端口**：`ports` 配置的范围里分给每个变更的一个端口，`setup` 和 hook 命令从 `CANON_PORT` 读到；记在协调数据库里，变更的 worktree 不在之后才给别的变更；只在开始和停下时新分配，新分配时跳过绑不上的端口（D-41、D-48、BR-2267、BR-2288）。
