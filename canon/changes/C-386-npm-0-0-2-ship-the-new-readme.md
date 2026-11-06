---
id: C-386
title: "npm 0.0.2: ship the new README"
status: open
rules: []
---

## 为什么

npm 包页面显示的是已发布版本里带的 README；0.0.1 发布时还是旧的两行 README，C-385 重写的 README 要发一个新版本才会出现在页面上。

## 要改什么

`package.json` 的版本号改成 0.0.2，合入后在 main 上执行 `npm publish`。规则不变。

## 教训

无

## 任务

- [x] 版本号改成 0.0.2
