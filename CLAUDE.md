# CLAUDE.md

Canon：为多个 AI 会话同时开发的项目提供共享记忆和协作协调。先读一遍 `canon/product.md`，里面的七条承诺（P1 到 P7）是这里所有东西存在的理由。

`canon brief` 输出的工作说明是通用流程的唯一来源，这里只写 canon 自己仓库另外的约定。

## 东西在哪

- `canon/architecture.md`：系统现在的部件、数据在哪、谁调谁。
- `canon/notes/`：调研和复盘。
- `.claude/skills/canon-*`：canon 自带的 skill，`canon init` 时装进每个用 canon 的项目；要改就在这里改（D-8、D-9、D-10）。
- `src/`：canon 的实现，`code_root: src`：`src/work/land/` 是 `work/land` 的代码，`src/kernel/` 是不属于任何领域的共享代码；测试放在它测的代码旁边。

## 怎么干活

```
canon update [--check]            # 更新 canon 装进项目的 skill 和 hook（用户要求时）
canon human ask "<问题>"          # 问人的另一种方式：记成待答问题，不依赖答案的工作继续做
```

- 规则的 `## 规则` 写在什么条件下产品必须怎样，`## 例子` 写边界两侧的具体输入和结果；例子就是测试要验证的东西。
- 每条生效的规则都要有测试名引用它，或者写明 `untested: <原因>`。
- `canon/` 下的文档一律用中文；代码、注释和测试名用英文。
- 写在反引号里的编号是举例，不算引用。
- 反直觉的代码加一行 `// reason:` 注释，写明依据的规则或决策编号。
- 停下（`canon work stop`）或合入前想一遍：这次工作证明哪条规则或决策错了；新建文档前用 `canon search` 查过重没有。
- 本项目的 issue 提到 GitHub（`gh issue create`）。
- 退出码：0 成功 · 1 被检查拒绝 · 2 用法错误 · 3 找不到 · 4 环境错误（git、文件、协调数据库）· 5 冲突（被别人认领、已回答、已存在）· 70 canon 的 bug · 75 还没完成、稍后再运行（排队超时、after-land 的命令还在跑、跟随合入时脱离；完整定义见 BR-2022、D-4）。
- 全局配置里的说明和本文件冲突时，以本文件为准。
