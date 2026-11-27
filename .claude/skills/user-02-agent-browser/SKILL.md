---
name: user-02-agent-browser
description: "agent-browser login profiles and session isolation. Use before an agent-browser run that needs login, runs in parallel, or must clean up."
---
## Agent Browser 持久化 Profile
- 默认无头自主操作；需登录态 → `agent-browser --session claude-profile --profile ~/.agent-browser/profiles/claude open <url>`。仅「未登录/验证码/2FA」让用户介入
- ⛔ 钥匙串不兼容：agent-browser 带 `--use-mock-keychain`，与系统钥匙串互不解密且打开即清空对方 cookie → 永不用普通 Chrome（`open -na`）打开该 profile 目录；profile 及备份 `claude-state.json` ⛔ 禁止清空/删除（chmod 600）
- ⛔ 不用 `--headed` 让用户登录 Google 类站点（CDP 自动化标记被拒）
- ⛔ profile 单实例：用前 `agent-browser session list`
- **`--session <name>` 不隔离 cookie —— 隔离靠 `--profile`**：不带 `--profile` 时所有 `--session` 实例**共用同一默认持久化 profile**，登录态跨任务渗漏。实测对照（env 里 `AGENT_BROWSER_PROFILE` 未设）：全新 session 名 + 无 `--profile` → 落 `/today`（**带着上一个任务的登录态**）；全新 session 名 + 全新空 `--profile` 目录 → 落 `/login`、`document.cookie` 为空。`--help` 自陈 `--profile <path>  Persist login sessions across restarts (cookies, IndexedDB, cache)`。⇒ 凡**并行**或**需身份隔离**的任务，每个 MUST 配独立 `--profile <dir>`；「匿名任务只给 `--session` 不给 `--profile`」是错的。代价实测：两个并行 UAT executor 各自进门就撞见对方的登录态，一度被当成产品的 P0 会话泄漏
- 会话用完即关：`agent-browser --session <name> close`（⚠️ v0.22.3 实测：`close` 是**顶层**命令、`--session` 是**全局选项**；`session` 子命令只有 `list`。写成 `agent-browser session close <name>` 不报错但**静默关掉 default 会话，目标会话照常存活**）。任务收尾必查 `session list`：headless Chrome 带 swiftshader 软渲染，残留实例长期烧 CPU（实测 3 个隔夜会话 + 1 个 5 天实例把机器底噪抬到 load 40+）
- 新站点登录流程 → 按需 Read 本 skill 的 `references/login.md`
