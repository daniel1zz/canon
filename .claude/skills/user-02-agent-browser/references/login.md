# Agent Browser — 新站点登录流程（临时 Chrome + CDP state 导出）

不碰主 profile（`~/.agent-browser/profiles/claude`）：用一次性临时目录登录，导出明文 cookie 后注入。

1. `open -na "Google Chrome" --args --user-data-dir=/tmp/ab-login-$RANDOM --no-first-run --remote-debugging-port=9223 <登录页URL>`（无自动化标记，Google 不拦；9222 常被占用，用 9223）
2. 用户在该窗口登录 → 完成后通知
3. `agent-browser --session state-export --cdp 9223 state save /tmp/site-state.json` 导出明文 cookie
4. kill 该 Chrome、删临时目录，然后 `agent-browser --session claude-profile --profile ~/.agent-browser/profiles/claude state load /tmp/site-state.json` 注入（merge 进 profile，mock 密钥落盘后自持），最后删 `/tmp/site-state.json`
5. 无头 open 目标站点验证登录态后才算完成

背景：agent-browser 启动 Chrome 带 `--use-mock-keychain`，与系统钥匙串互不解密，且打开时会清空解密失败的 cookie——因此登录必须走「临时目录 + state 导出」，绝不直接打开 profile 目录。流程实测验证 2026-07-06。
