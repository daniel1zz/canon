/**
 * canon's flow, from a session starting to main being accepted: the stages and the steps in each (BR-2540, D-140).
 * Only the skeleton lives here; which config keys configure a step is declared by each key in its domain's
 * `config-keys.ts` (`ConfigKey.flow`), the same way the keys themselves are (C-135).
 */

export interface FlowStep {
  readonly id: string;
  readonly title: string;
  /** What the step does, in one sentence. */
  readonly about: string;
  /** For a step canon always runs, which no key turns off: the promise of canon/product.md it upholds. */
  readonly builtin?: "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7";
}

export interface FlowStage {
  readonly id: string;
  readonly title: string;
  /** The command the stage belongs to. */
  readonly command: string;
  readonly steps: readonly FlowStep[];
}

export const FLOW = [
  {
    id: "session", title: "会话开始", command: "canon brief",
    steps: [
      { id: "session.instructions", title: "常驻说明", about: "每个会话开始时都要读的文件；改动其中一个会触发重复说明评审。" },
      { id: "session.reminders", title: "工作提醒", about: "议程按事件送到会话：可派的活、要判断的事、等负责人的事；canon work watch 只报变化，不定时重复。" },
    ],
  },
  {
    id: "start", title: "开工", command: "canon work start",
    steps: [
      { id: "start.claim", title: "认领变更", about: "同一个变更同一时间只有一个会话在做；认领它的会话不在了，别的会话可以立刻接手。", builtin: "P4" },
      { id: "start.worktree", title: "建 worktree", about: "每个变更有自己的 worktree 和分支，第一次进入时跑一次安装；配了端口范围时还分一个端口。" },
      { id: "start.after_start", title: "hook：after_start", about: "开工之后运行的项目命令。" },
      { id: "start.delegate", title: "派给 worker", about: "canon work delegate 把设计好的变更交给另一个会话做，受同时派活数和机器负载的上限约束。" },
    ],
  },
  {
    id: "test", title: "测试", command: "canon work test",
    steps: [
      { id: "test.typecheck", title: "类型检查", about: "在挑出的测试文件之前跑一次。" },
      { id: "test.select", title: "挑测试文件", about: "改过的测试、选测试命令挑出的测试、点名了改过的规则的测试，加上每次都跑的测试。" },
      { id: "test.run", title: "跑测试", about: "每个测试文件单独跑一次，按 CPU 并行，有总时限。" },
      { id: "test.check", title: "canon check", about: "文件有效、编号唯一、引用能解析、规则和测试互相点名、代码目录和领域对应。", builtin: "P5" },
    ],
  },
  {
    id: "preview", title: "评审预览", command: "canon work review",
    steps: [
      { id: "preview.review", title: "规则评审", about: "评审命令读入提示、输出 JSON 格式的意见；太大的评审拆成几次调用。" },
      { id: "preview.related", title: "挑相关文档", about: "从融合排序的前 50 个里，让一个命令挑出和规则或决策真正相关的文档。" },
    ],
  },
  {
    id: "land", title: "合入", command: "canon work land",
    steps: [
      { id: "land.queue", title: "合入排队", about: "所有合入排同一条队；被拒的在一段时间内保留位置；可以几个一起测。", builtin: "P4" },
      { id: "land.design", title: "设计依据", about: "碰到持久化数据、边界或依赖的变更，要写明设计依据。" },
      { id: "land.floor", title: "floor 测试", about: "在将要成为 main 的那棵代码树上跑的全量测试命令。" },
      { id: "land.before_land", title: "hook：before_land", about: "移动 main 之前运行的项目命令；有一个失败就拒绝这次合入。" },
      { id: "land.main", title: "移动 main", about: "比较并交换：这期间 main 被别人移动过，就重新来过，不会覆盖别人的提交。", builtin: "P4" },
    ],
  },
  {
    id: "after", title: "合入后（后台）", command: "canon work after-land",
    steps: [
      { id: "after.push", title: "推送 main", about: "每次合入后把 main 推到配置的远端。" },
      { id: "after.after_land", title: "hook：after_land", about: "合入之后运行的项目命令，不拦合入。" },
      { id: "after.review", title: "规则评审", about: "改了规则、决策或常驻说明的合入在后台评审；意见挂在对应的文档上。" },
      { id: "after.code_review", title: "代码评审", about: "canon 不自己启动代码评审：项目在 after_land hook 里运行评审脚本（canon 仓库用 scripts/code-review.ts），脚本在合入攒够一批、或最早的一个等得够久时评审。" },
      { id: "after.floor", title: "后台 floor", about: "floor 改到合入后跑时：main 安静一段时间、攒够一批没测的合入、或最早的一个等得够久，就测 main 的最新提交。" },
      { id: "after.after_green", title: "hook：after_green", about: "后台 floor 通过后运行的项目命令；必须能安全地重跑。" },
    ],
  },
  {
    id: "stop", title: "停下与收尾", command: "canon work stop · canon work clean",
    steps: [
      { id: "stop.after_stop", title: "hook：after_stop", about: "停下一个变更的工作之后运行的项目命令。" },
      { id: "stop.clean", title: "清理 worktree", about: "worktree 里能重建的忽略文件随它一起删掉；其他被忽略的文件都算工作，会保留。" },
    ],
  },
  {
    id: "accept", title: "验收与自我改进", command: "canon accept · canon links · canon stats",
    steps: [
      { id: "accept.links", title: "可疑引用", about: "从一个起点提交开始，跟踪规则和决策之间的引用是否过时。" },
      { id: "accept.checks", title: "检查复核", about: "每个检查可以定一个复核日期，到期时 canon stats 会提示。" },
    ],
  },
] as const satisfies readonly FlowStage[];

/** The id of a step in FLOW: a key naming a step that does not exist does not compile. */
export type StepId = (typeof FLOW)[number]["steps"][number]["id"];
