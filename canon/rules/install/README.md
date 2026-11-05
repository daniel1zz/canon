# 安装和更新（install）

canon 自带的项目级 skill、会话 hook、每次 Bash 调用前做快照的 hook（D-30）和让 main 只能通过 `canon work land` 移动的 git 守卫怎样装进项目、怎样更新（D-9、D-10、D-16）：`canon init` 安装，`canon update` 把更新作为一个变更合入，`canon brief` 和 `canon work start` 在装的东西过期时提示一行；`canon uninstall` 把它们移除（D-46）：先合入一个删掉 canon 装的文件和 `canon/config.yaml` 的变更，再清理每个克隆里不进版本库的东西。

`canon init` 是第一次安装：建出 `canon/` 的标准目录结构和 `canon/config.yaml`，不覆盖已有的文件（BR-2032、BR-2076）；它的代码也在这里（`src/install/commands.ts`）。

不管：其余命令的行为和退出码（`invocation`）。依赖：`invocation`（命令的声明方式和退出码）。

## 术语

- **canon 自带的 skill**：canon 仓库 `.claude/skills/canon-*` 下的 skill，装进项目的同名目录。
- **过期**：项目里 canon 装的东西和当前 canon 带的版本不一致（缺少、内容不同、canon 已删掉，会话 hook 缺少或是旧形式、Bash 快照 hook 缺少、提问工具记录 hook 缺少、`worktree.baseRef` 缺少或不是 `"head"`、canon 撤回的 hook 或放行规则还在，git 守卫缺少、是旧内容或不是 canon 写的，或 `info/exclude` 里缺少 `/.claude/worktrees/` 一行，BR-2305）；项目自己改过、canon 又没有新版本的文件不算（BR-2089）。
- **git 守卫**：canon 写进仓库 hook 目录的 `reference-transaction` hook（`src/install/githook.ts`），canon 进了 main 以后，拒绝 `canon work land` 以外让 main 指向新提交的操作（BR-2126）。
