# CLAUDE.md

Canon：为多个 AI 会话同时开发的项目提供共享记忆和协作协调。先读一遍 `canon/product.md`，里面的七条承诺（P1 到 P7）是这里所有东西存在的理由。

## 东西在哪

- `canon/rules/<领域>/BR-n.md`：产品现在必须怎么工作，一条规则一个文件。`canon/rules/<领域>/README.md` 写明这个领域管哪些代码、现在的结构和术语。领域按业务能力分子领域（`canon/rules/<领域>/<子领域>/`），`canon rule domains` 列出全部；一个领域直接的规则超过 25 条时拆分。
- `canon/decisions/D-n.md`：为什么这么定。`canon/changes/C-n.md`：要做的工作。`canon/notes/`：调研和复盘。
- `.claude/skills/canon-*`：canon 自带的 Claude Code skill，项目级别，`canon init` 时装进每个用 canon 的项目；canon 更新后，`canon brief` 会提示，用户要求时运行 `canon update`；要改就在这里改（D-8、D-9、D-10）：`canon-design`（设计，结果落到决策和规则）、`canon-diagnose`（调试）、`canon-test`（写测试）、`canon-uat`（验收）、`canon-rules`（写规则）、`canon-triage`（分流 issue）、`canon-product`（该做什么）、`canon-prototype`（原型）、`canon-context-optimizer`（压缩常驻说明）。
- `src/`：canon 的实现。测试名以它证明的规则编号开头（`it("BR-2014: ...")`）。

## 怎么干活

```
canon context <路径|C-n|领域>     # 改代码前先读：领域说明和规则标题；要改的规则用 canon show 读全文（--full 给全部）
canon search <词|编号>
canon work start <C-n>            # 开始一个已有的变更；或 --title "<要做什么>" 新建
  ...先写清变更文件的“为什么”和“要改什么”，再改代码和规则，提交...
canon work land [--finish]        # 排队 → rebase → floor → canon check → 规则评审 → main
canon work stop --next "<下一步>"  # 没做完就停下时
canon update [--check]            # 更新 canon 装进项目的 skill 和 hook（用户要求时）
canon work drop <C-n>             # 放弃一个变更的 worktree 和分支；会丢的东西先存档再删
canon human ask "<问题>"          # 只用于方向，或明确留给人的决定
canon human answer <n> <回答> --relayed "<人的原话>"  # 人在对话里回答后，由 agent 如实转述记下
```

- 行为变了，就在同一个提交里改对应的规则文件；新规则用 `canon rule new --domain <领域> --title "..."`。
- 一条规则只描述一个可以独立测试的行为，正文分两段：`## 规则`（在什么条件下，产品必须怎样）和 `## 例子`（边界两侧的具体输入和结果）。例子就是测试要验证的东西。
- 每条生效的规则都要有测试名引用它，或者写明 `untested: <原因>`。
- 有真实备选方案的重要选择，写一个决策：`canon decision new --title "..."`。
- `canon/` 下的文档一律用中文；代码、注释和测试名用英文。
- 写在反引号里的编号是举例，不算引用。
- 要删除带未合入提交或未提交改动的 worktree、删除未合入的变更分支，用 `canon work drop`，不要直接用 git：它先把会丢的东西（提交、未提交和未跟踪的文件、不能重新生成的被忽略文件）存档到 `refs/canon/archive/<C-n>/<时间>`，读回校验后才删除，并打印恢复命令，不问人（D-13）。
- 留给人的问题，先用提问工具问负责人，再用 `canon human answer --relayed` 记下负责人的原话；只转述负责人真实说过的话，不替他决定（D-6）。
- 必须问人（`canon human ask`，或在对话里直接问）的情形还包括：要花钱的操作（付费 API、云资源）、对共享范围不可逆的操作（发布、删除远端数据、推送到别人的仓库）、需要人的凭据或二次验证。其余不等人。
- 在 worktree 里只跑和改动相关的测试；全量测试由 floor 在合入时跑一次。多个 worktree 同时跑全量测试会互相拖慢，曾出现负载 150、70 多个假失败。
- 反直觉的代码加一行 `// reason:` 注释，写明依据的规则或决策编号。
- 停下（`canon work stop`）或合入前想一遍：这次工作证明哪条规则或决策错了；新的决策写了被否决的方案没有；新建文档前用 `canon search` 查过重没有。
- 合入是唯一的关卡。被拒绝时，提示会写明要修什么；修好后重新合入。
- 现在不修的问题，提成 GitHub issue（`gh issue create`）：一个根因一个 issue，附上能复现的命令，以及期望结果和实际结果。
- 退出码：0 成功 · 1 被检查拒绝 · 2 用法错误 · 3 找不到 · 4 环境错误（git、文件、协调数据库）· 5 冲突（被别人认领、已回答、已存在）· 70 canon 的 bug · 75 排队超时（完整定义见 BR-2022、D-4）。

## 现在的状态

旧系统 lore 归档在 `~/Projects/zz/lore`（GitHub `daniel1zz/lore`），不要在这里使用 `lore` 命令或旧 lore 的 skill。全局配置里还有旧 lore 的规则和 hook，处理方案见 C-3；在它完成之前，和本文件冲突的全局规则以本文件为准。
