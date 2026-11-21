import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const landGuide: readonly GuideLine[] = [
  { rank: 80, text: `Finish a Change with canon work land --finish, a chore with canon chore land; both share the queue and checks. Other work commands (test, review, stop, status, after-land, clean, drop, take, unstall) also apply to chores. Landing is the only gate: when refused, fix what it names and land again. Stopping before that: canon work stop --reason land|design|owner|deps|partial --next "<next step>".` },
  { rank: 90, text: `Landing can wait minutes behind others and runs in the background: a timeout or Ctrl-C only stops following it; canon work land again follows it, --stop stops it. Read its exit code directly.` },
  { rank: 95, text: `Changes start and land by tier, P0 first (canon priority set): the main session sets P1 to P3 with --reason "<why>", never to hurry its own change; the owner's tier, P0 included, only when the owner asked for it in the conversation, with --relayed "<the owner's own words>" (canon backlog urgent <C-n> --relayed is the owner's P1; --clear removes either). Workers set none.` },
];
