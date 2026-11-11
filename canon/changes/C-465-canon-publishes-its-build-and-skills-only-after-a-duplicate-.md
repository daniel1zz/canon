---
id: C-465
title: canon publishes its build and skills only after a duplicate review of every shipped skill together
status: open
rules: [BR-2411, BR-2412, BR-2082, BR-2366]
---

## 为什么

canon 仓库合入时的重复评审只把改动过的 skill 全文放进提示（BR-2143），两个 skill 正文之间的重复在源头查不出来，到下游 `canon update` 时才被项目的重复评审拦下（#159、#182）。负责人选了方案 B（canon human #23）：发布前在 canon 仓库把所有发出的 skill 一起评审一次；下游跳过 canon 的文件由 C-462 做。

查证发现编译好的 `dist/canon` 安装的 skill 取自主 checkout 的工作树（main 最新），不是构建二进制的那个测过的提交，所以评审必须和“把 skill 跟着二进制一起发布”一起做才拦得住下游拿到的东西（D-91，proposed）。

## 要改什么

- `scripts/release.ts`（`after_green` 调用）：发布评审（BR-2411，`src/knowledge/review/release-review.ts`），通过后发布（BR-2412，`src/install/publish.ts`）；拦截时不发布、写明发现、在 GitHub 新建或评论 `canon-review` issue、退出码 1；`--check` 只评审。
- `skillsSource` 对编译好的 canon 先用 `dist/skills`（BR-2082）。
- `CANON_REVIEW_KIND` 多一个 `release`（BR-2366）。
- `canon/config.yaml` 的 `after_green` 改成 `bun scripts/release.ts`；`canon/architecture.md` 写明发布流程。
- 决策 D-91（proposed）。

## 陷阱和假设

- 第一次发布时 `dist/skills` 还不存在，`dist/canon` 回退到仓库的 `.claude/skills`；第一次后台测试通过后才有快照。
- 第一次发布评审如果就拦下（现有 skill 里已有重复），PATH 上的 canon 会停在旧版本，直到改好 skill。
- 假设 `after_green` 的临时 worktree 里有 `node_modules`（floor 先跑 `bun install`），并且能运行 `gh`。

## 教训

- 改动前以为 `after_green` 构建的 canon 就是下游拿到的全部，实际 skill 来自主 checkout 的工作树 → 现在由 BR-2082、BR-2412 保证 skill 和二进制来自同一个发布

## 任务

- [x] 发布评审和发布的代码、测试
- [x] 规则、决策、架构文档、配置
