# 先合后测（work/watch）

项目把 `floor_timing` 设成 `after` 时，合入不等 floor：rebase、每个变更自己的检查（`canon check`、来源核对、规则评审、`before_land`）通过后 main 就前移，floor 改为在后台对 main 的最新提交跑；没通过时不追查是哪个变更造成的，由下一个空闲会话针对失败去修（向前修，D-31）。因为 PATH 上的 canon 只从通过的提交构建，`after` 下的合入还要确认 PATH 上的 canon 读得了合入后的配置（BR-2224）：新配置项先合入，main 通过后再启用。默认的 `before` 是先测再合（BR-2014），这个领域的规则在 `before` 下都不起作用。

## 术语

- **后台测试**：对 main 的某个提交跑一次 floor，在 git 公共目录下的临时 worktree 里进行，不碰主 checkout。后台测试进程可能比它测的提交旧：自己的代码读不了那个提交的配置、PATH 上的 canon 读得了时，交给 PATH 上的 canon 重测（BR-2250）。
- **通过的提交**：最近一次后台测试通过的 main 提交，记在 `refs/canon/green`；PATH 上的 canon 这类东西只应从它构建（`after_green`）。
- **main 没通过**：最近一次后台测试失败，协调数据库里有一条记录（提交、日志、输出尾部、修复它的变更），直到之后某次后台测试通过。
- **修复 main 的变更**：用 `canon work start --fix-main` 开的变更，同一时间只有一个。
