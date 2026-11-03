# 安装和更新（cli/install）

canon 自带的项目级 skill 和会话 hook 怎样装进项目、怎样更新（D-9、D-10）：`canon init` 安装，`canon update` 把更新作为一个变更合入，`canon brief` 和 `canon work start` 在装的东西过期时提示一行。

不管：其余命令的行为和退出码（`cli`）。

## 术语

- **canon 自带的 skill**：canon 仓库 `.claude/skills/canon-*` 下的 skill，装进项目的同名目录。
- **过期**：项目里 canon 装的东西和当前 canon 带的版本不一致（缺少、内容不同、canon 已删掉，或会话 hook 缺少或是旧形式）；项目自己改过、canon 又没有新版本的文件不算（BR-2089）。
