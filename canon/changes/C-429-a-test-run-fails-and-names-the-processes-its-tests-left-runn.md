---
id: C-429
title: A test run fails and names the processes its tests left running, then
  kills them
status: open
rules: []
---

## 为什么

测试结束后没有回收它生成的进程，这个问题反复出现：#119（hooks.test.ts 留下 after_land 等待循环）、hang 进程、after-land 进程，都是同一个根因。现有的防护（`src/work/testkit.ts` 的 `processReaper()`、`hang()`、有上限的循环，C-329、C-374）要每个测试自己接入：24 个直接启动进程的测试文件里只有 12 个用了它，被测代码启动的 detached 进程（after-land、review 脚本）更容易漏掉。漏一次就留下一批挂在 pid 1 下的进程，没有任何东西会报出来。

## 要改什么

- 新增 `scripts/reap-test-procs.sh`：按进程的当前目录找出某次测试运行留下的进程（测试的临时目录都在 `scripts/test.sh` 给这次运行建的 `canon-test.<runner pid>.<随机>` 下，子进程继承当前目录；detached 进程换了进程组、父进程变成 1，只有当前目录还能找到它们）。macOS 用 `lsof -d cwd`，有 `/proc` 时读 `/proc/<pid>/cwd`，两者都没有就以退出码 4 失败，不当成“没有残留”。
  - `--run <dir>`：列出并 SIGKILL 当前目录在 `<dir>` 里的进程，有就退出 1。
  - 不带参数：手动运行，列出 runner 已经不在的运行目录里还在跑的进程，只列不杀；加 `--kill` 才杀。runner 还活着的运行一律不碰。
  - 只杀查到的单个进程，不杀进程组：不是 detached 的子进程和 bun、test.sh、终端在同一个组里。
- `scripts/test.sh`：`bun test` 结束后对本次运行目录跑 `--run`；有残留就点名、杀掉，并让这次运行失败（bun 本来失败就保留 bun 的退出码，否则退出 1）。开始清理上一轮被 SIGKILL 留下的目录时，先杀掉还在里面的进程。被信号停止时也回收。
- `scripts/test-sh.test.ts`：覆盖以上几点；换回旧的 test.sh 时其中 3 条失败。
- 新检查在全量测试里查出的残留：
  - `src/work/verify/verify.test.ts` 的 "a second signal while the stop waits turns the hurry flag on" 用假的 `stop` 代替真的，没有结束被测文件的进程组：假 `stop` 现在自己 SIGKILL 这些组。
  - `src/work/watch/watch.test.ts`：after_green 通过后 watcher 把下一次测试交给 PATH 上的（假）`canon floor watch`（BR-2251），这个进程不在 watcher 表里，负载高时会比测试活得久（6 次里 1 次）。假 canon 现在记下自己的 pid，afterEach 等每次 `floor.handoff` 交出去的假 canon 都结束。改后连跑 6 次没有残留。
  - `src/work/remote/remote.test.ts` 的残留是产品缺陷：push/fetch 超时只杀 `git`，它启动的钩子和传输进程留下。单独记成 #162 修，本变更等它合入后再合入，否则 main 的 floor 会被这个残留拦下。
- 不改产品代码，不加规则：和 C-376 一样，这是本仓库自己的测试脚本，不是产品行为。

## 陷阱和假设

- 假设测试启动的进程当前目录都在本次运行的 TMPDIR 下（测试都用 `tmpdir()` 建临时目录）。当前目录切到别处的进程查不到，只能靠 `processReaper()`。
- `lsof` 报的是真实路径（`/private/tmp/...`），比较前要先 `pwd -P`。

## 教训

测试不回收自己启动的进程 → 现在由 `scripts/test.sh` 结束时的检查保证（`scripts/reap-test-procs.sh`，`scripts/test-sh.test.ts`），漏掉的测试会让运行失败，进不了 main。

## 任务

- [x] scripts/reap-test-procs.sh
- [x] test.sh 结束时检查、开始时清理、信号时回收
- [x] scripts/test-sh.test.ts
- [x] 全量测试跑一遍，修掉新检查查出的测试残留（verify、watch）
- [ ] #162 合入后在 main 上重跑全量测试，再合入
