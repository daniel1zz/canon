---
id: C-491
title: canon init and canon update write links_since when it is missing
status: open
rules: [BR-2452, BR-2032, BR-2084]
---

## 为什么

负责人在 canon human #27 选了 A：`canon init` 和 `canon update` 在项目没有 `links_since` 时自动写入当时 main 的提交，等于对每个项目都采用 #25 A（起点提交里已有的引用都算复核过）。没有这个键时 `canon links` 以退出码 4 失败，`canon brief` 和 `canon context` 多打一行。canon 自己的仓库也要设上。

## 要改什么

- 新规则 BR-2452：`canon/config.yaml` 没有 `links_since`（没写或写成 null）而 main 已有提交时算过期，`canon update --check` 列出，`canon update` 在它的变更里写入开变更时 main 的完整编号（null 那一行换掉，否则在末尾加注释和这一行，其余行不动）；已有的值从不改；main 没有提交时不算过期。BR-2084 的过期清单加上这一项。
- BR-2032：`canon init` 新写配置、main 已有提交时写入 main 当时的编号；main 还没有提交时不写，输出一句由第一次提交之后的 `canon update` 写；已有的配置不改（BR-2076）。
- 代码：`src/install/update.ts`（`mainTip`、`withLinksSince`、过期项和变更里的写入），`src/install/commands.ts`（init）。
- canon 自己的 `canon/config.yaml` 设 `links_since: "ed64e11b5cdbcc7857c76500464a4f996665b6a5"`：设置时 main 和 13:44 发布的 `dist/canon` 都在这个提交，两边都认识这个键（实测 `dist/canon config --schema` 有 `links_since`，main 的 `src/knowledge/links/config-keys.ts` 声明了它），BR-2248 和 BR-2224 都不拒绝。

## 陷阱和假设

- 测试里“项目已是最新”的夹具要带上 `links_since`，否则 `update --check` 会列出它；夹具的第二次提交要像合入一样绕过 main 守卫（`CANON_LAND_MAIN`）。
- 起点设好后，这次改的 BR-2032、BR-2084 的引用方会显示为可疑引用；这次的改动只是加了一项，没有逐条复核。

## 教训

无

## 任务

- [x] BR-2452、BR-2032、BR-2084 和代码、测试
- [x] canon 自己的配置设上 `links_since`
