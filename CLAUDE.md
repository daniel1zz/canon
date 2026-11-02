# CLAUDE.md

Canon：为多个 AI 会话同时开发的项目提供共享记忆和协作协调。先读一遍 `canon/product.md`，里面的七条承诺（P1 到 P7）是这里所有东西存在的理由。

## 东西在哪

- `canon/rules/<领域>/BR-n.md`：产品现在必须怎么工作，一条规则一个文件。`canon/rules/<领域>/README.md` 写明这个领域管哪些代码。
- `canon/decisions/D-n.md`：为什么这么定。`canon/changes/C-n.md`：要做的工作。`canon/notes/`：调研和复盘。
- `src/`：canon 的实现。测试名以它证明的规则编号开头（`it("BR-2014: ...")`）。

## 怎么干活

```
canon context <路径|C-n|领域>     # 改代码前先读：整个领域的当前内容
canon search <词|编号>
canon work start <C-n>            # 开始一个已有的变更；或 --title "<要做什么>" 新建
  ...先写清变更文件的“为什么”和“要改什么”，再改代码和规则，提交...
canon work land [--finish]        # 排队 → rebase → floor → canon check → 规则评审 → main
canon work stop --next "<下一步>"  # 没做完就停下时
canon work drop <C-n>             # 放弃一个变更的 worktree 和分支；会丢工作时先问人
canon human ask "<问题>"          # 只用于方向，或明确留给人的决定
```

- 行为变了，就在同一个提交里改对应的规则文件；新规则用 `canon rule new --domain <领域> --title "..."`。
- 一条规则只描述一个可以独立测试的行为，正文分两段：`## 规则`（在什么条件下，产品必须怎样）和 `## 例子`（边界两侧的具体输入和结果）。例子就是测试要验证的东西。
- 每条生效的规则都要有测试名引用它，或者写明 `untested: <原因>`。
- 有真实备选方案的重要选择，写一个决策：`canon decision new --title "..."`。
- `canon/` 下的文档一律用中文；代码、注释和测试名用英文。
- 写在反引号里的编号是举例，不算引用。
- 要删除带未合入提交或未提交改动的 worktree、删除未合入的变更分支，用 `canon work drop`，不要直接用 git：它会列出会丢的东西、问人，人同意后再执行，每一步都记进事件表。
- 合入是唯一的关卡。被拒绝时，提示会写明要修什么；修好后重新合入。
- 现在不修的问题，提成 GitHub issue（`gh issue create`）：一个根因一个 issue，附上能复现的命令，以及期望结果和实际结果。
- 退出码：0 成功 · 1 被检查拒绝 · 2 用法错误 · 3 找不到 · 5 冲突（被别人认领、已回答、已存在）· 75 排队超时（完整定义见 BR-2022）。

## 现在的状态

旧系统 lore 归档在 `~/Projects/zz/lore`（GitHub `daniel1zz/lore`），不要在这里使用 `lore` 命令或旧 lore 的 skill。全局配置里还有旧 lore 的规则和 hook，处理方案见 C-3；在它完成之前，和本文件冲突的全局规则以本文件为准。
