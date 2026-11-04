# 远端（work/remote）

让本机的 main 和项目配置的 git 远端（`remote`）保持一致：合入移动 main 之后把 main 推上去（备份，也让从远端建 worktree 的工具拿到最新代码），推送失败时记下来并在 `canon brief` 里提示；`canon sync` 在远端的 main 比本地新、而且能快进时把它拉到本地（D-38）。只推、只拉 main 这一个分支，不推标签，从不强推，从不合并：两边分叉时怎样合由人决定。

不管：合入本身（排队、floor、检查、比较并交换，见 `work/land`），推送不改变合入的结果；远端的托管平台（分支保护、权限）。

## 术语

- **远端**：`canon/config.yaml` 的 `remote` 写的 git 远端名字（`git remote` 列出的那种，例如 `origin`）。读的是 main 上已提交的配置。
- **远端的 main**：远端的 `refs/heads/<main>`；本机记在 `refs/remotes/<远端>/<main>`，推送成功和 `canon sync` 取远端时更新。
- **没推上去的提交**：本地 main 上有、`refs/remotes/<远端>/<main>` 上没有的提交。
- **快进**：本地 main 是远端 main 的祖先，把本地 main 直接移到远端 main，不产生新提交。
- **分叉**：两边各有对方没有的提交，不能快进。
