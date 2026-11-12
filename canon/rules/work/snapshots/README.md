# 快照（work/snapshots）

让 worktree 里没提交的工作不会彻底丢掉（P4）：每次 Bash 调用前，canon 装进项目的 hook 把未提交的工作存成快照，之后不管是 `git checkout <文件>`、`rm`、脚本覆盖文件还是别的什么弄丢了，都能从快照里找回（D-30）。只记录、不拦截任何命令：canon 不判断 agent 怎么干活。hook 怎样装进项目属于 `install`（BR-2185）。

## 业务

- **未提交工作找回**：保存未提交工作的快照，列出其中的文件和找回方法。

## 术语

- **快照**：一个 git 提交，父提交是当时的 HEAD，树是那一刻 worktree 的内容（跟踪文件的改动和没被忽略的未跟踪文件），存在 `refs/canon/snapshots/<worktree 目录名>/<时间>` 下，只在本机，默认的 `git push` 不推它。
- **worktree 的键**：worktree 目录名；变更 worktree 的就是变更编号，主 checkout 是它的目录名。
