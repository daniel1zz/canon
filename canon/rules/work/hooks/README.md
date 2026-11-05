# 生命周期 hook 和变更端口（work/hooks）

项目在 `canon/config.yaml` 的 `hooks:` 里为变更的生命周期事件（`after_start`、`before_land`、`after_land`、`after_stop`、`after_green`）配置命令，canon 在对应时刻运行它们，把这一刻的事实放进 `CANON_*` 环境变量；`ports:` 给每个变更分一个固定端口 `CANON_PORT`，`setup` 和 hook 命令都拿得到。每次运行都写进事件表；后台的 `after_land` 命令的退出码和代码评审结果用 `canon work after-land` 查看（D-2、D-3、D-41、D-48）。

依赖：`work`（协调数据库 `src/work/db.ts`，记事件、端口和后台运行的批次）、`work/land/queue`（`canon work after-land` 查合入尝试是否被中断）。被使用：`work/session`（开始、停下时运行 `after_start`、`after_stop`，分端口，`canon brief` 提示后台命令的失败）、`work/land`（`before_land`、后台 `after_land`、合入时按变更取端口）、`work/watch`（`after_green`，没有变更所以没有端口）、`cli/install`（卸载时等后台命令结束）。

不管：命令开头的脚本路径是否存在（所有配置的命令都检查，BR-2197，属于配置的读取）；`hooks`、`ports` 这两个键的名字、类型和校验写在这个领域的 `src/work/hooks/config-keys.ts`，由 `src/config/config.ts` 汇总（C-135）。

## 术语

- **hook**：在 `after_start`、`before_land`、`after_land`、`after_stop`、`after_green`（BR-2222）五个事件上运行的命令；只有 `before_land` 能拒绝合入。`after_green` 的命令必须能重复运行，以 `CANON_GREEN` 为准（BR-2222）。
- **前台 hook 和后台 hook**：前台 hook 在命令里等它结束并打印输出的最后 40 行（BR-2200）；后台的 `after_land` 命令各在自己的子 shell 里运行，输出写进日志，结束后退出码记进事件表（BR-2137、BR-2201）。
- **变更的端口**：`ports` 配置的范围里分给每个变更的一个端口，`setup` 和 hook 命令从 `CANON_PORT` 读到；记在协调数据库里，变更的 worktree 不在之后才给别的变更；只在开始和停下时新分配，新分配时跳过绑不上的端口（D-41、D-48、BR-2267、BR-2288）。
