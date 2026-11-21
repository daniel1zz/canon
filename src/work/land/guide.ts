import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const landGuide: readonly GuideLine[] = [
  { rank: 80, text: `Finish a Change with canon work land --finish, a chore with canon chore land; both share the queue and checks. Other work commands (test, review, stop, status, after-land, clean, drop, take, unstall) also apply to chores. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --reason land|design|owner|deps|partial --next "<next step>".` },
  { rank: 90, text: `Landing can wait minutes behind others and runs in the background: a timeout or Ctrl-C only stops following it; canon work land again follows it, --stop stops it. Read its exit code directly.` },
  { rank: 95, text: `Changes start and land by tier, P0 first: canon priority set <C-n> <P1-P3> --reason "<why>", never for your own change; the owner's tier (P0 too; canon backlog urgent is P1) only when they asked in the conversation, with --relayed "<their words>". Workers set none.` },
];
