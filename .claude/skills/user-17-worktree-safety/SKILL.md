---
name: user-17-worktree-safety
description: How worktree subagents get their base commit (settings worktree.baseRef = head; the default fresh builds from origin and once left an agent 56 commits behind) and the check to run before trusting any measurement from a worktree (git -C <wt> log --oneline -1 must match the bundle baseline). Use when dispatching a subagent with isolation worktree or reading results produced in one.
---
### ⛔ Worktree 并发安全
- worktree 基线由 `~/.claude/settings.json` 的 `worktree.baseRef: "head"` 机制保证（2026-10-07 实测：本地领先 origin 8 提交时，`isolation:worktree` 子 agent 的 HEAD == 本地 HEAD）。根因是默认值 `fresh` 从 `origin/<default>` 建 worktree，曾致 agent 在落后 56 提交的代码上工作。⛔ 该设置被移除/覆盖即退回旧行为；故 worktree 建好后、采信其任何测量前，仍 MUST 复核 `git -C <wt> log --oneline -1` 与 bundle baseline 对齐。嵌套派发已由 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` 关闭。`knowledge-worktree-agents-are-built-from-origin-main-not-local`
