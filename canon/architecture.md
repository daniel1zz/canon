---
title: 架构总览
---
# 架构总览

只写现在的样子，只画两层：上下文（谁在用、依赖什么外部系统）和容器（运行时有哪些部件、数据存在哪、谁调用谁）。每一节末尾的编号指向为什么这么做的决策。这里只回答“哪个部件、数据在哪、谁调谁”：步骤的先后和每个行为的要求写在规则里，部件内部怎么分看领域 README（`canon context <路径或领域>`），领域清单看 `canon rule domains`。改了部件或谁调谁的变更，同一次合入里更新这里（D-65）。

分两类写：「canon 做的」是装了 canon 的任何项目都有的部件；「本项目配的」是 canon 自己这个仓库在 `canon/config.yaml` 里配的东西，别的项目不一定有。

## 上下文

- **使用者**：在项目里干活的 AI 会话（Claude Code），常常几个同时在跑；负责方向的人，只回答 `canon human` 里的问题。
- **git**：一切的底座。main 是一个分支，每个变更一个 worktree 和分支；canon 的协调数据放在 git 公共目录里。
- **Claude Code**：会话在它里面运行。canon 把 hook 和 skill 装进项目的 `.claude/`；读它的提问记录来佐证转述的回答；`canon usage` 只读它的会话记录。
- **`claude -p`**：非交互的 Claude，用于合入时的规则评审，命令由 `canon/config.yaml` 的 `review` 配置；合入后的代码评审也是项目自己配的；canon 仓库发布前的发布评审用同一个 `review` 命令（BR-2411）。
- **GitHub**：`canon issues` 列出开着的 issue（`src/work/issues`，只读，关闭用 `gh`）；canon 仓库的发布评审拦截时新建或评论一个 `canon-review` issue（BR-2411）；决策里引用的网址在合入时被抓取核对；`remote` 指向它时合入后把 main 推上去。
- **varlock**（可选，开源的密钥工具）：项目根目录有 `.env.schema` 时（D-85），合入运行它找变更里提交的密钥明文，用被合入树的 `node_modules/.bin/varlock`，没有就用 PATH 上的；canon 不转述 `varlock scan` 的输出（`src/work/land/checks/secrets.ts`，D-86）。
- **项目自己的命令**：floor、类型检查、测试、选测试的命令（`test_select_command`）、`setup`、生命周期 hook，由 `canon/config.yaml` 配置，canon 只运行它们、看退出码；测试命令把 JUnit XML 报告写到 `{report}`，canon 读报告里有哪些测试、跑没跑，不认语言（D-64）。

决策：D-1、D-2、D-9、D-45、D-51、D-64、D-86。

## 容器：canon 做的

**CLI 二进制 `canon`**
- 职责：全部命令；没有常驻进程（后台部件见下）；唯一一直运行的命令是前台的 `canon events --follow`，它是被调用方停止的长命令，不是后台部件（BR-2357）；跟随后台合入的 `canon work land` 也可能运行很久，它跟随的后台合入进程只活到这次合入结束（BR-2390）。多数命令读运行它的 checkout 里的 `canon/config.yaml`；合入评审的命令、时限、提示预算 `review_max_prompt_kb`、同时运行的调用数 `review_parallel` 和常驻说明清单例外，取自 main 上已合入的配置（BR-2074；`canon check` 的评审大小提示在 worktree 里也读 main 上的预算，D-76），所以在一次合入里改它们只对之后的合入生效；canon 仓库的发布评审（`scripts/release.ts`）读被发布提交自己的配置。
- 数据：无。
- 代码：`src/invocation`（命令声明、退出码、配置读取；`tree.ts` 汇总各领域的 `commands.ts`）、`src/invocation/reference`（配置项参考和 schema）；共享的 git、进程、结果类型在 `src/kernel`，不属于任何领域。
- 决策：D-2、D-3、D-4、D-15、D-28、D-63。

**协调数据库 `state.db`**
- 职责：多个会话同时工作时的共享状态：认领、合入队列、负责人标的优先合入（`canon backlog urgent`）、交接记录、留给人的问题、编号、端口、事件表（每次写入和拒绝）、后台部件的登记、未处理的评审意见（`review_findings`，见合入后的命令和评审）。
- 数据：`<git 公共目录>/canon/state.db`（SQLite），本机所有 worktree 共用，不提交、不跨机器。知识（规则、决策）不放这里。
- 代码：`src/work`（`db.ts`、`workspace.ts`），各子领域读写自己的表；`src/work/humans`（留给人的问题）、`src/work/stats`（从事件表算统计，`canon stats`、`canon events`、`canon usage`）。
- 决策：D-6、D-11、D-18、D-33、D-41、D-45、D-47、D-73。

**主 checkout 与变更 worktree**
- 职责：主 checkout 签出 main，main 只通过 `canon work land` 前移；每个变更一个 worktree `<仓库名>.worktrees/C-n`、一个分支 `change/C-n`、一个认领（租约加进程探测）。认领的持有者是会话，子 agent 的名字写在后面（`agent:<会话>:<名字>`）：子 agent 的认领类命令（`work start`、`land`、`stop`、`drop`）带 `--as <自己的 agent_id>`，主会话不带；主会话用 `canon work take <C-n> --from <agent_id>` 接手子 agent 的变更。快照（每次 Bash 前给 hook 的 `cwd` 所在 worktree 和调用者自己认领的其他 worktree 各做一个，D-71；按文件名认出的密钥文件不放进去，BR-2406）和归档是 git ref：`refs/canon/snapshots/*`、`refs/canon/archive/*`。
- 数据：worktree 里的代码和 `canon/changes/C-n.md`；每个 worktree 的 `.canon/`（生成的 schema，被 git 忽略）。
- 代码：`src/work/session`（开始、停下、交接、`canon brief`）、`src/work/claims`（认领、`--as` 的解析、`check-as` hook 的检查）、`src/work/drop`、`src/work/snapshots`。
- 决策：D-11、D-13、D-18、D-30、D-62、D-71。

**合入流水线（`canon work land`）**
- 职责：把一个变更变成 main：排队（上次因 `canon check` 被拒、内容和 main 都没变时，入队前先重跑 `canon check`，还有发现就不排队，BR-2388）、在 rebase 后的树上跑检查和评审，项目有 `.env.schema` 时先扫描密钥（D-86）、移动 main、合入后推送和启动后台命令；配了 `land_batch_max` 时把排队的变更串成一批在临时 worktree 里测；配了 `floor_scopes` 时只改某个范围的合入跑那个范围的命令、排到全量合入前面（D-82）。`canon work land` 只是跟随者：合入运行在它启动的后台合入进程里（自己的进程组，输出和退出码写在 `logs/land-run-*/`，`src/work/land/detach.ts`），调用者被杀或按 Ctrl-C 只脱离，再运行就接上（还在启动、正在跑，或已结束而没人看到结果的都算；判断和记下 `land.spawn` 在一个写事务里，同一 worktree 只开一次合入，BR-2392），`--stop` 停止；状态放 `state.db`。合入前的验证 `canon work test` 也在这里：选出和这个变更有关的测试文件（改动的、`test_select_command` 选出的、点名了碰过的规则的），一个文件一次运行，把 `test_command` 里的 `{report}` 换成临时路径，读 JUnit 报告并按（测试文件路径，内容哈希）记账，最后跑类型检查和 `canon check`。步骤的先后见 `canon/rules/work/land/README.md` 和各子领域规则。
- 数据：`state.db` 里的队列条目和测试报告记账；批在 git 公共目录下的临时 worktree。
- 代码：`src/work/land`（横跨整个流程）、`src/work/land/queue`、`src/work/land/batch`、`src/work/land/checks`、`src/work/land/finish`、`src/work/verify`、`src/work/remote`（合入后推 main，`canon sync` 只快进）。
- 决策：D-5、D-16、D-22、D-26、D-29、D-32、D-34、D-38、D-42、D-58、D-64、D-73、D-75、D-80、D-82、D-86。

**`canon/` 文档树**
- 职责：项目的共享记忆，进版本库：`canon/product.md`、`canon/architecture.md`、`canon/config.yaml`、`canon/backlog.md`、`canon/rules/<领域>/`（规则和领域 README）、`canon/decisions/`、`canon/changes/`、`canon/notes/`，需要时有 `canon/releases/`。一个文档一个文件，只在合入时改。
- 数据：Markdown 加 front matter。`canon check` 查格式、引用、路径、规则有没有被一个会运行的测试点名（读 `state.db` 里的测试报告记账，不运行测试，D-64）；`canon search`、`canon context` 读它，每次运行时现算，不存索引：`canon search` 逐字匹配加汉字二元组匹配，`canon context`、`canon work review` 和编辑 hook 给出规则或决策的相关文档（正文引用的双向关系图、二元组 BM25 全文、共用名字三种排名的倒数排名融合，D-90）。规则和决策之间的引用只从正文读；复核过的引用记在引用方 front matter 的 `links` 里（`canon links confirm` 写，`canon check` 查它和正文对得上），没记的由 `canon links`、`canon context`、`canon brief` 每次从 git 历史（当前提交的第一父提交链）算出是不是可疑，不另存（D-95）。
- 代码：`src/knowledge`（横跨整个领域）、`src/knowledge/documents`、`src/knowledge/check`、`src/knowledge/check/restatement`（复述别的规则的文字判定，hook、`canon check` 和规则评审共用，D-84）、`src/knowledge/query`（搜索、上下文和相关文档的融合排序）、`src/knowledge/releases`、`src/knowledge/plans`（变更文件里 `## 计划` 表的读取、检查和 `canon plan status`，步骤状态由做它的变更算出）、`src/knowledge/links`（引用和可疑引用、`canon links`）、`src/work/execution`（规则的执行状态由变更里的通过记录算出）。
- 决策：D-1、D-12、D-14、D-15、D-32、D-61、D-64、D-65、D-77、D-84、D-90、D-95。

**装进项目的 hook、skill 和 git 守卫**
- 职责：Claude Code hook（会话开始跑 `canon brief`；每次 Bash 前快照、检查 `canon work` 命令带不带 `--as`（`canon work check-as`，只拒绝、不改写）；提问工具之后记录回答；Write、Edit 或 MultiEdit 之后提示改动的规则或决策在新行里复述了别的规则，并列出和它最相关的几份文档，`canon restatements --hook`，不调模型，D-84、D-90）、`.claude/skills/canon-*`、git 的 `reference-transaction` hook（main 只能由 `canon work land` 移动；新建文档的命令也问 `githook.ts` 当前签出是不是受守卫的 main，是就拒绝，BR-2409）。
- 数据：项目的 `.claude/settings.json`、`.claude/skills/`、git hook 目录里的守卫文件；skill 的来源是 canon 自己仓库的 `.claude/skills`；编译好的 `dist/canon` 先用和它一起发布的 `dist/skills`，npm 包用包里的，`CANON_SKILLS_SOURCE` 可以另指（BR-2082、BR-2412）。`canon init` 和 `canon update` 还写只有标题的 `canon/architecture.md`（已有的不覆盖）。
- 代码：`src/install`（`init`、`install`、`update`、`uninstall`、`githook.ts`）。
- 决策：D-9、D-10、D-16、D-36、D-46、D-53、D-62、D-65、D-84。

**后台 floor watch（`floor_timing: after` 时）**
- 职责：合入后在 git 公共目录下的临时 worktree 里，对 main 的最新提交按批跑 floor；通过就移动 `refs/canon/green` 并运行 `after_green`；没通过就记下，由下一个会话 `canon work start --fix-main` 向前修。
- 数据：`refs/canon/green`，`state.db` 里的 watcher 和 red_main 表，日志在 git 公共目录下。
- 代码：`src/work/watch`。
- 决策：D-31、D-55、D-59。

**合入后的命令和评审**
- 职责：合入后在主 checkout 里后台运行配置的 `after_land` 命令，记下日志和退出码；运行和记录配置的生命周期 hook、每个变更的端口 `CANON_PORT`；两种评审的提示词和结果：合入时对规则、决策、常驻说明的规则评审（调用配置的 `review` 命令；拆成几次调用时同时运行，D-83；同样的提示通过过就沿用，改动文档和上次通过时一样就只对之后合入 main 的文档做小评审，D-70、D-81），和合入后的代码评审（怎么跑由项目配）。重复评审不评审 canon 装进项目、项目没改过的 skill 文件，所以 `canon update` 的合入不做重复评审（BR-2410）。规则评审还拦截新写的行里复述别的规则的行为，提示里附上这次新增或改动的行和文字判定找到的候选；小评审只附新增或改动的行（BR-2405、D-84）。
- 数据：`refs/canon/code-reviewed`，后台命令的日志和退出码（事件表）；未处理的评审意见在 `state.db` 的 `review_findings` 表里，一个身份同时最多一行，挂在点名的每份文档上，关闭时记下方式和关闭它的事件（合入、判定或复问）；不拦截的建议不在这张表里，仍从 `land.ok` 事件读（D-21、D-97）。
- 代码：`src/work/hooks`、`src/knowledge/review`；未处理的评审意见在 `src/knowledge/review/findings`，`canon context`、`canon brief` 显示它们，合入和 `canon verdict record` 关闭它们。
- 决策：D-2、D-19、D-21、D-51、D-59、D-84、D-97。

## 容器：本项目配的

canon 这个仓库在 `canon/config.yaml` 里配了下面这些，是项目配置，不是 canon 的部件：

- **`dist/canon` 和 `dist/skills`**：只在主 checkout 里，PATH 上的 canon 指向 `dist/canon`，它装进项目的 skill 来自 `dist/skills`（指向 `skills-<提交>` 的符号链接）。`after_green` 运行 `scripts/release.ts`：先把测过的提交里所有 `canon-*` 的 SKILL.md 和工作说明放在一起做一次重复评审（同样的文字只评审一次），通过才从这个提交编译二进制、复制 skill、切换链接；拦截时什么也不发布，提一个 `canon-review` issue，退出码 1。不从没测过的 main 构建（D-31、D-91、BR-2411、BR-2412）。
- **`scripts/review-claude.sh`**：`review` 配的命令，用 `claude -p` 做规则评审，也用于发布评审（`CANON_REVIEW_KIND=release`）。
- **`scripts/code-review.ts`**：`after_land` 配的命令，攒批后让 `claude -p` 评审合入的代码，只找安全和并发问题，发现的提成 GitHub issue；没到点时在后台留一个等待进程（`--wait`，协调数据库的 `code_review_waiter` 保证只有一个），到点评审后退出（D-59、D-68）。
- **floor**：类型检查加 `scripts/test.sh`；`floor_timing: after`、`land_batch_max: 4`。

## 主要流程

```mermaid
flowchart LR
  A[work start] --> B[改 + work test] --> C[work land]
  C --> D[排队 / 成批]
  D --> E[检查 + 评审]
  E --> F[移动 main]
  F --> G[push remote]
  F --> H[after_land 后台]
  F --> I[floor watch 后台] -->|通过| J[after_green]
  I -->|没通过| K[fix-main 变更向前修]
```

- **一个变更**：`work start`（子 agent 带 `--as <agent_id>`）建 worktree、分支和认领；改完 `work test`；`work land --finish` 进合入流水线，只有 main 通过比较并交换前移；`work after-land <C-n> --wait` 等后台命令；`work clean` 删 worktree。每一步的要求看 `work/session`、`work/verify`、`work/land` 的规则（D-5、D-16、D-22、D-62）。
- **后台 floor watch**：合入移动 main 后启动，在自己的进程组里；测过的结果决定 `refs/canon/green`，没通过的记进 red_main，`canon brief` 提示（D-31、D-55、D-59）。
- **问人**：`canon human ask` 把问题记进 `state.db`（`src/work/humans`）；人在对话里回答，提问工具的 hook 记录；`canon human answer --relayed` 对照记录，对不上只标记（D-6、D-45、D-47）；例外是带选项的问题，回答和原话说的选项不同、或把人自己的话改写了，按 BR-2021 拒绝。
- **计划**：大工作在变更文件的 `## 计划` 表里写步骤和依赖；做步骤的变更在 front matter 写 `plan: C-n` 和 `steps`（`canon work start --plan --step` 开工时写好，已经开工的用 `canon plan link` 补上）；`canon plan status` 从变更的状态算出每步已完成、进行中、可开始还是被挡住，不另存；`canon brief`（没认领变更的地方）列出有可开始步骤的计划，`canon change list` 标出步骤和计划进度，`canon work start --step` 提示这一步已有哪个变更在做，都用同一个算法（`src/knowledge/plans`，D-77）。
- **发版**：规则带 `release: R-n` 标签，计划变更也可以带（它的计划属于这个版本）；`canon release status` 按规则的执行状态和计划的进度算版本进度；`canon release ship R-n` 在规则全部通过、计划全部完成、负责人确认后开变更把版本设为 shipped（`src/knowledge/releases`，D-61、D-79）。
