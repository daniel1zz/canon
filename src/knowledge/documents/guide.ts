import type { GuideLine, GuideTopic } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const documentGuide: readonly GuideLine[] = [
  { rank: 40, text: `When behavior changes, change its rule in the same commit (new rule: canon rule new --domain <domain> --business <its business> --title "..."); how to write one is canon-rules' job.` },
  { rank: 50, text: `Pick the domain by business capability, not by command name or technical layer: see canon rule domains; when none fits, create a subdomain (canon rule domain <domain>/<name>) and name it in the change file.` },
  { rank: 60, text: `A significant choice with real alternatives becomes a decision (canon decision new --title "..." --amends <D-n>|"none: <why>"), rejected options included.` },
  { rank: 65, text: `Deciding what to build next, or whether a feature is worth building: use the canon-product skill before writing rules.` },
];

export const documentTopics: readonly GuideTopic[] = [
  { name: "lessons", when: `this work taught something about the process or tools: a pitfall you hit, something a measurement showed, a problem a subagent reported`, text: `First judge whether the lesson can become a mechanism: a check, a command, a rule, a test or a hook. If it can, ask the user whether to make it one, and make nothing before they confirm: no rule, check, command, skill or CLAUDE.md is changed, and you do not choose on your own which instructions it goes into. If it cannot, say why it can only live in text. Writing it into a prompt or instructions does not count as making it a mechanism.

In a canon change, write each lesson under ## 教训 in the change file with where it went: a mechanism's id, 只靠文字：<原因>, or 待负责人确认是否固化. The rules, tests and checks a change wrote for its own feature or fix are not lessons.` },
];
