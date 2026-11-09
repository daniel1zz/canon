---
id: C-438
title: canon work land runs the landing detached; the caller dying or pressing
  Ctrl-C only detaches (#161)
status: done
rules:
  - BR-2390
  - BR-2391
  - BR-2392
  - BR-2393
  - BR-2099
  - BR-2307
  - BR-2309
  - BR-2022
passes:
  BR-2022: 3f251c8e0a9f0026 test
  BR-2099: b204edc12815a7d8 test
  BR-2307: caf7a6d10d413b3e test
  BR-2309: 3f469f41b10cfc82 test
  BR-2390: fb78cc0ca7a550c4 test
  BR-2391: ec85b8b6a754c3ce test
  BR-2392: 9cb039de5b7793ab test
  BR-2393: 7604d9443175efd9 test
---

## 为什么

#161：`canon work land` 在调用它的进程里从头跑到尾。调用的工具超时，或宿主在 60 分钟时杀掉后台命令，合入就跟着被杀。排队位置会保留（D-75），但要有人发现并重来，正在跑的 floor 也白跑了。队列忙时等 35 到 79 分钟是常事；另一个项目一天记到 32 次 `land.killed`，工人改用 `nohup` 后变成 0 次。

负责人 2026-11-09 定了（canon human #11，“只脱离（推荐）”）：调用的人按 Ctrl-C 只是不再跟着看，合入在后台继续。

## 要改什么

- `canon work land` 默认把合入放到自己独立的会话里运行（有自己的日志），前台命令只跟着输出，合入结束时用同样的退出码返回。调用者被杀、断开、收到 SIGHUP，都不影响后台的合入。
- 前台按 Ctrl-C：只脱离，打印怎么接上、怎么停止，退出码按“还没完成”（75）。
- 在同一个 worktree 再运行 `canon work land`：后台合入还在进行就接上它，不新开一个；已经结束就报那次的结果。
- 新增一个明确停止后台合入的方式（例如 `canon work land --stop`），停下后按 BR-2099 让出轮次。
- 后台合入进程本身被杀，仍按 BR-2099、BR-2309、D-58 处理；`--timeout` 管后台合入。
- 新决策 D-80（修订 D-58）写明“默认后台运行、Ctrl-C 只脱离”和被否决的方案；改 BR-2099、BR-2307、BR-2309、BR-2022，新增 BR-2390（后台运行和跟随）、BR-2391（脱离）、BR-2392（接上）、BR-2393（停止）。

不做：不改排队位置的规则（D-75）。

## 教训

- Bun 不带 `env` 启动子进程时用的是进程启动时的环境，之后改 `process.env`（包括删掉一个变量）对这些子进程不起作用；所以后台合入按父进程判断，而不是把 `CANON_LAND_RUN` 从环境里去掉。写进了 D-80 的决定和 `src/work/land/detach.ts` 的 reason 注释；可以做成检查（例如 `canon check` 或测试不许 `src` 里写 `delete process.env` 或给 `process.env` 赋值后再不带 `env` 启动子进程），现在 `src` 里没有别的代码这样用；做不做：待负责人确认是否固化。

## 任务

- [x] 决策（D-80）
- [x] 规则
- [x] 后台运行、接上、停止
- [x] 测试：杀掉前台进程后合入照样完成；再运行能接上；停止后让出轮次（`src/work/land/detach.test.ts`）
