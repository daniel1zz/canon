# 移动 main 和收尾（work/land/finish）

检查都通过之后的事：main 只通过比较并交换从测过的那个提交移到合入的提交，只有这一条 git 命令带放行标记；`--finish` 在进队列前用一个随工作一起合入的关闭提交把变更设为 `done`，合入没让 main 移动时撤回它，关闭提交做不成时变更文件怎样留下；关闭前要求写好教训；合入成功后释放认领、删除 handoff，并在后台跑 `after_land`。

不管：移动 main 之前的检查（`work/land/checks`）、一起测时领头怎样锁定成员（`work/land/batch`）、合入者被信号终止时让出轮次（`work/land/queue`，撤回关闭提交按这里的 BR-2018）、main 只能由 canon 移动的 git hook 本身（`install`，BR-2123、BR-2126）。

关闭变更前要写好教训（BR-2161）放在这里而不是 `work/land/checks`，因为它是关闭变更的要求，只在 `--finish` 关闭时检查。

## 术语

- **比较并交换**：只有 main 仍是 rebase 时的那个提交，才把它移到新提交。
- **关闭提交**：`--finish` 做的 `canon: close C-n` 提交，把变更状态设为 `done`，和工作一起合入。
- **撤回（reopen）**：合入没让 main 移动时，把关闭提交从分支上拿掉，变更回到 `open`。
- **放行标记**：`CANON_LAND_MAIN`，只设在移动 main 的那条 git 命令的环境里（BR-2125）。
