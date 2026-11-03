---
code:
  - src/work/work.ts
  - src/work/overlap.ts
  - src/app
  - src/repo/git.ts
  - src/cli/guide.ts
---

# 变更的开始、停下和交接（work/session）

一个变更从开始到结束在 worktree 里怎么过：`canon work start` 新建或接手一个变更（worktree、分支、变更文件、认领），`canon work stop` 记下下一步，下一个会话由 `canon brief` 看到自己在做什么和别的变更；`canon work clean` 删除已经合入、没人在用、也不会丢东西的 worktree。代码在 `src/work/work.ts` 的 `start`、`stop`、`clean`，同文件提示在 `src/work/overlap.ts`，工作说明在 `src/cli/guide.ts`。

不管：认领的规则（`work/claims`）、合入（`work/land`）、放弃（`work/drop`）。

## 术语

- **worktree 目录**：变更的 worktree 放在 `<仓库名>.worktrees/C-n`（可配置）。
- **setup**：新 worktree 建好后运行的项目命令，失败时不留下半成品。
- **重叠**：两个进行中的变更改了同一个文件。
