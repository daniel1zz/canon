# 调用约定（invocation）

怎样调用 canon，所有领域都遵守这套约定（D-63）：`canon` 命令行的参数怎样声明、帮助怎样写、每个退出码只有一种含义，以及 `canon/config.yaml` 怎样读、写错时怎样失败。agent 或人要做的每个动作对应一个命令，各命令的行为写在各自的领域里；canon 自带的 skill 和 hook 怎样装进项目属于 `install`。子领域 `invocation/reference`：让人和 agent 看到配置能设置什么、现在设成什么。

这个领域取代了按技术层命名的 `cli` 和 `config`（D-63）。

命令不集中登记：每个子领域在自己代码目录的 `commands.ts` 里定义自己的命令和它在 `--help` 里的位置，`src/invocation/tree.ts` 只按领域列表组装（`src/invocation/main.ts` 只运行它），只有新增领域时才改（D-15）。

`canon/config.yaml` 的读取和校验，以及项目扩展 canon 的方式（D-2、D-3）：策略参数、文档类型、生命周期 hook、文档模板；文档类型和模板的规则在 `knowledge/documents`，hook 和端口的规则在 `work/hooks`。租约、掉线、排队超时这些参数各自的行为写在 work 领域的规则里，这里只管配置本身怎样读、怎样报错（包括每条命令开头的脚本路径是否存在，BR-2197）。具体某一项的规则归用它的领域（D-63）：文档类型和模板在 `knowledge/documents`，hook 和端口在 `work/hooks`，`tests` 和 `code_root`、`shared` 在 `knowledge/check`，`instructions` 在 `knowledge/review`，`test_command` 在 `work/verify`，`floor_skip_paths` 在 `work/land/checks`。

配置项不集中登记：每一项（名字、类型、默认值、校验、说明）由用它的领域在自己代码目录的 `config-keys.ts` 里声明，`src/invocation/config.ts` 只把它们组装起来、按顺序校验，只有新增领域时才改；`src/invocation/` 里没有任何配置项的声明。

## 术语

- **退出码**：0 成功；1 被结果检查拒绝；2 用法错误或输入无效；3 找不到；4 环境错误；5 冲突（被另一个 worktree 认领、已经回答过、已经存在）；70 canon 自身的 bug；75 还没完成、稍后再运行（合入排队超时、`canon work after-land` 的命令还在运行）。完整定义见 BR-2022 和 D-4。
- **配置项的声明**：一个配置项的名字、类型、默认值、校验和说明，写在用它的领域的 `config-keys.ts` 里；`src/invocation/config.ts` 只汇总、按每项的 `listed` 和 `checked` 的数值排序，不按领域的先后。
