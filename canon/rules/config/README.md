# 配置与扩展（config）

`canon/config.yaml` 的读取和校验，以及项目扩展 canon 的方式（D-2、D-3）：策略参数、文档类型、生命周期 hook、文档模板；文档类型和模板的规则在 `knowledge/documents`，hook 和端口的规则在 `work/hooks`。租约、掉线、排队超时这些参数各自的行为写在 work 领域的规则里，这里只管配置本身怎样读、怎样报错（包括每条命令开头的脚本路径是否存在，BR-2197）。具体某一项的规则归用它的领域（D-63）：文档类型和模板在 `knowledge/documents`，hook 和端口在 `work/hooks`，`tests` 和 `code_root`、`shared` 在 `knowledge/check`，`instructions` 在 `knowledge/review`，`test_command` 在 `work/verify`，`floor_skip_paths` 在 `work/land/checks`。

配置项不集中登记：每一项（名字、类型、默认值、校验、说明）由用它的领域在自己代码目录的 `config-keys.ts` 里声明，`src/config/config.ts` 只把它们组装起来、按顺序校验，只有新增领域时才改；`src/config/` 里没有任何配置项的声明。
