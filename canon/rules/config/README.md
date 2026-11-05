# 配置与扩展（config）

`canon/config.yaml` 的读取和校验，以及项目扩展 canon 的方式（D-2、D-3）：策略参数、文档类型、生命周期 hook、文档模板；文档类型和模板的规则在 `knowledge/documents`，hook 和端口的规则在 `work/hooks`。租约、掉线、排队超时这些参数各自的行为写在 work 领域的规则里，这里只管配置本身怎样读、怎样报错（包括每条命令开头的脚本路径是否存在，BR-2197），以及和代码目录与规则领域怎样对应（`code_root`、`shared`，D-15）。文档类型（声明的读取和校验、模板、必填段落）属于 `knowledge/documents`（D-63）。

配置项不集中登记：每一项（名字、类型、默认值、校验、说明）由用它的领域在自己代码目录的 `config-keys.ts` 里声明，`src/config/config.ts` 只把它们组装起来、按顺序校验，只有新增领域时才改；`code_root` 和 `shared` 这两项暂时仍声明在 `src/config/config-keys.ts`；类型和模板的声明在 `src/knowledge/documents/config-keys.ts`，`hooks` 和 `ports` 的声明在 `src/work/hooks/config-keys.ts`。

## 术语

- **共享代码**：`shared` 列出的、不属于任何业务领域的代码（共享内核）。
