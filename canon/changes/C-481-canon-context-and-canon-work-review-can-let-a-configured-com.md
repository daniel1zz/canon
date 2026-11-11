---
id: C-481
title: canon context and canon work review can let a configured command pick
  related documents from the fused top 50, cached and loud on failure (C-464 F)
status: open
rules: [BR-2443, BR-2444, BR-2445]
plan: C-464
steps:
  - F
---

## 为什么

D-90 的实测：融合排序的前 10 名覆盖 64% 的评审意见配对；取前 50 名让便宜的模型挑选后到 73%（跨领域 63% → 73%），前 5 名 45% → 54%。模型调用不能放进编辑 hook（每次编辑的延迟和花费），所以做成可选的、按需的挑选命令，只在 `canon context <编号>` 和 `canon work review` 里用（验收由 G 步调用同一个函数）。

## 要改什么

- 新配置项 `related_pick_command`（可选）和 `related_pick_timeout_seconds`（默认 120），声明在 `src/knowledge/query/config-keys.ts`，取自 main 上的 `canon/config.yaml`（BR-2443）。本变更不在 canon 自己的 `canon/config.yaml` 里配置它（BR-2248；负责人 canon human #26：发布的 dist/canon 认得这个键之后才能用）。
- `src/knowledge/query/pick.ts`：提示（A 的全文和前 50 名的编号、标题、约 220 字的摘要）、回答的解析、缓存（协调数据库的 `related_picks` 表，键是命令和提示的 SHA-256，BR-2444）、失败时的一行原因（BR-2445）；`relatedSections` 给 `canon context`、`canon work review` 用，G 步的验收也调它。
- 新规则 BR-2443（挑选和输出）、BR-2444（缓存）、BR-2445（失败和丢掉的编号）；architecture.md、领域 README 和 D-90 的后果同步。

## 陷阱和假设

- 缓存键用的是提示的哈希而不是语料提交（D-90 后果里写明了理由）：提示里没有的文字变了不会再调用，这是有意的。
- 挑选命令在运行命令的 checkout 里执行，不像评审那样在 main 的临时 worktree 里：它只是提示、不拦截，而为每次 `canon context` 建一个 worktree 太慢；命令文字仍取自 main。
- `canon work review` 的相关文档一段现在在评审之前算（和以前一样），配了命令时会多一次模型调用。

## 教训

无。

## 任务

- [x] 规则 BR-2443、BR-2444、BR-2445 和测试（假命令，不调模型）
- [x] `canon context`、`canon work review` 接入；architecture.md、README、D-90 同步
