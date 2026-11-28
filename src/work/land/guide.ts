import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090) and its topics `canon guide <topic>` prints (BR-2654); src/invocation/guide.ts puts them in order. */
export const landGuide: readonly GuideLine[] = [
  { rank: 80, text: `Finish a Change with canon work land --finish, a chore with canon chore land. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --reason land|design|owner|deps|partial --next "<next step>". Queue waits, priorities, after landing: canon guide land.` },
];

export const landTopics: readonly GuideTopic[] = [
  { name: "land", when: `landing: waiting behind others, setting a priority tier, following up after it lands, or using work commands on a chore`, text: `A Change and a chore share the queue and checks. Other work commands (test, review, stop, status, after-land, clean, drop, take, unstall) also apply to chores.

Landing can wait minutes behind others and runs in the background: a timeout or Ctrl-C only stops following it; canon work land again follows it, --stop stops it. Read its exit code directly.

Changes start and land by tier, P0 first: canon priority set <C-n> <P1-P3> --reason "<why>", never for your own change; the owner's tier (P0 too; canon backlog urgent is P1) only when they asked in the conversation, with --relayed "<their words>". Workers set none.

After it lands, the project's post-land commands run in the background: canon work after-land --wait <C-n> (your change: another landing may come after yours) waits for them and the rule review, prints each exit code and their review lines; use it instead of reading or polling the log.` },
];
