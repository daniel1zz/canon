---
id: C-376
title: Run tests under a small private TMPDIR so leftover test directories
  cannot slow every process (#126)
status: done
rules: []
---

## 为什么

解决 #126 的根因。C-374、C-375 去掉了测试里靠猜时长的等待，但改前改后全量测试都是 14 分钟（852 秒对 840 秒）：固定等待只占测试总时间的约 1.5%，不是超时的原因。

实测的根因：bun 启动一个进程时会读这个进程的当前目录往上每一级目录的内容。测试每个用例都建一个临时目录（`canon-next-work-*` 等）并且从不删除，本机共享的 TMPDIR（`/var/folders/.../T`）里已经积了 534,469 个，其中 190,733 个是 `project()` 建的 git 仓库。测试里每启动一个 canon 进程，cwd 都在这个 TMPDIR 下，于是每次都先读一遍 53 万项的目录：

- `bun src/invocation/main.ts human pending`，cwd 在 TMPDIR 下：1.7 秒（sys 0.6 秒）；cwd 在 `/tmp/...` 下：0.06 秒。TMPDIR 环境变量指向别处不改变结果，只有 cwd 的祖先目录大小起作用。
- `main.test.ts` 的 BR-2154 单独跑：8.7 秒，换到小目录下 1.55 秒。
- 每次全量测试又多留下几千个目录，所以测试一轮比一轮慢，每次是不同的、单独跑都能过的测试撞 30 秒超时，机器上再有别的测试进程时更明显。

## 要改什么

- `scripts/test.sh`：测试用自己的 TMPDIR，建在 `/tmp`（`CANON_TEST_TMP_ROOT` 可改）下的 `canon-test.<runner pid>.<随机>`，不用共享的 TMPDIR；结束时（包括失败）整个删掉；上一轮被 SIGKILL 没来得及删的，在下一轮开始时按“runner 进程已经不在”删掉；建不出来就直接失败，不退回到共享 TMPDIR。git 配置文件也放进这个目录。
- 新增 `scripts/test-sh.test.ts`：用一个只记录收到什么的假 `bun` 证明上面几点（TMPDIR 在 run root 下且不是共享的，参数原样传给 bun test，退出码照传，失败后也删，只删 runner 已经不在的，建不出来时失败）。改前这 4 条全部失败。
- 不改产品代码，不改任何测试的断言，不调超时。

本机共享 TMPDIR 里已经积下的 53 万个目录不在本变更里删：它们在仓库之外，删除要负责人决定（命令见 #126 的评论）。

## 教训

测试从不清理自己的临时目录，是个能做成机制的问题：本变更让 test.sh 的 TMPDIR 在每轮结束时整个删掉，机制已经在 test.sh 里，并由 scripts/test-sh.test.ts 保证。

## 任务

- [x] test.sh 用私有 TMPDIR，结束时删，开始时清上一轮被杀留下的
- [x] scripts/test-sh.test.ts
