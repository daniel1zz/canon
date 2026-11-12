# 安装和更新（install）

canon 自带的项目级 skill、会话 hook、每次 Bash 调用前做快照的 hook（D-30）和让 main 只能通过 `canon work land` 移动的 git 守卫怎样装进项目、怎样更新（D-9、D-10、D-16）：`canon init` 安装，`canon update` 把更新作为一个变更合入，`canon brief` 和 `canon work start` 在装的东西过期时提示一行；`canon uninstall` 把它们移除（D-46）：先合入一个删掉 canon 装的文件和 `canon/config.yaml` 的变更，再清理每个克隆里不进版本库的东西。

`canon init` 是第一次安装：建出 `canon/` 的标准目录结构和 `canon/config.yaml`，不覆盖已有的文件（BR-2032、BR-2076）；它的代码也在这里（`src/install/commands.ts`）。

不管：其余命令的行为和退出码（`invocation`）。依赖：`invocation`（命令的声明方式和退出码）。

## 业务

- **初始化**：把一个还没有 canon 的仓库变成 canon 项目：建出 `canon/` 的骨架，已经存在的文件原样保留。
- **安装**：把 canon 带的 skill 文件写进项目，记下清单；只写它自己的那片地方，项目改过的文件不覆盖。
- **更新**：项目里装的东西和 canon 当前带的版本比对：哪些算过期、怎么告诉人、更新怎么作为一个变更合进去。
- **项目设置**：往项目的 `.claude/settings.json` 和 git 的 `info/exclude` 里合并 canon 要用的 hook 和配置，撤回的照样移除。
- **main 守卫**：装进 git hook 目录的守卫：谁能移动 main、拒绝时留下什么状态、拒绝时告诉人用什么命令。
- **卸载**：把 canon 从项目里撤掉：什么情况下不许撤、撤掉哪些东西、找得回来的留着。
- **发布**：canon 发布出去的东西：编译好的 canon 和它安装的 skill 从同一个测过的提交一起出，以及这些文字里不能写什么。

## 术语

- **canon 自带的 skill**：canon 仓库 `.claude/skills/canon-*` 下的 skill，装进项目的同名目录；安装时从哪里读（发布的 `dist/skills`、npm 包、`CANON_SKILLS_SOURCE`）见 BR-2082。
- **过期**：项目里 canon 装的东西和当前 canon 带的版本不一致（缺少、内容不同、canon 已删掉，会话 hook 缺少或是旧形式、Bash 快照 hook 缺少、提问工具记录 hook 缺少、检查 `--as` 的 hook 缺少、编辑后复述提示 hook 缺少、`worktree.baseRef` 缺少或不是 `"head"`、canon 撤回的 hook 或放行规则还在，git 守卫缺少、是旧内容或不是 canon 写的，`info/exclude` 里缺少 `/.claude/worktrees/` 一行（BR-2305），或项目里没有 `canon/architecture.md`（D-65），或 main 已有提交而 `canon/config.yaml` 没有 `links_since`（BR-2452））；项目自己改过、canon 又没有新版本的文件不算（BR-2089）。
- **git 守卫**：canon 写进仓库 hook 目录的 `reference-transaction` hook（`src/install/githook.ts`），canon 进了 main 以后，拒绝 `canon work land` 以外让 main 指向新提交的操作（BR-2126）。
