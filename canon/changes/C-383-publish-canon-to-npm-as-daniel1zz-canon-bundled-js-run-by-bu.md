---
id: C-383
title: publish canon to npm as @daniel1zz/canon (bundled JS run by bun)
status: open
rules: [BR-2082]
---

## 为什么

canon 只能从源码仓库编译出本机能用的 `dist/canon`，别的项目和机器装不上。要把它作为 npm 包 `@daniel1zz/canon` 发出去，用 `npm i -g` 就能装。npm 上的 `canon` 已经被别人占了，所以用 scope 名；分发方式按负责人的选择，发打包好的单个 JS 文件，由 bun 来运行，这样所有平台都能用。

## 要改什么

- `package.json`：包名改成 `@daniel1zz/canon`，去掉 `private`，`bin` 指向 `dist/canon.js`，`files` 只带 `dist/canon.js` 和 `.claude/skills/canon-*`，新增 `build:npm` 脚本（`bun build --target bun`），`prepublishOnly` 先构建；运行时依赖都已打进包里，挪到 devDependencies。
- `src/install/install.ts`：找 skill 的候选路径加上 `dist/` 的上一级，即包的根目录（BR-2082）。
- `src/work/watch/watch.ts`：后台测试重新启动 canon 时，不是编译好的二进制、又找不到源码，就用 `bun <Bun.main>` 启动，原来只剩一个裸的 `bun`。
- 修改 BR-2082：加上 npm 包这种情况。

## 陷阱和假设

- 用户机器上要有 bun（>=1.3）；`#!/usr/bin/env bun` 找不到 bun 时，canon 会直接启动失败。
- 打包后 `import.meta.dir` 是 `dist/`，不再是源码里各文件自己的目录，任何按源码目录层级找文件的代码都要考虑这一点。

## 教训

打包成单个 JS 后，按源码目录层级找文件的路径会错 → 现在由 BR-2082 的 npm 包测试保证

## 任务

- [x] package.json 改成可发布的 npm 包
- [x] 打包后找 skill、重新启动 canon 的路径修好
- [x] BR-2082 加上 npm 包的情况和测试
