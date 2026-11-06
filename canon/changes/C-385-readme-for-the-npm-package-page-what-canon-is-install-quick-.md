---
id: C-385
title: "README for the npm package page: what canon is, install, quick start"
status: done
rules: []
---

## 为什么

README 只有两行，说明要去读 `canon/product.md` 和 `CLAUDE.md`。npm 包页面显示的就是 README，装包的人在那里看不到 canon 是什么、需要什么环境、怎么装、怎么开始用。

## 要改什么

重写根目录的 `README.md`（英文）：canon 是什么、它保证的几件事（来自 `canon/product.md` 的承诺）、环境要求（bun 1.3 或更高、git、Claude Code、可选的 gh）、`npm install -g @danielzz/canon`、`canon init` 上手、常用命令和退出码。规则不变。

## 教训

无

## 任务

- [x] 重写 README.md
