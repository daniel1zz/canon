import type { GuideLine } from "../../invocation/guide.ts";

/** This domain's lines of the workflow guide `canon brief` prints (BR-2090); src/invocation/guide.ts puts them in rank order. */
export const documentGuide: readonly GuideLine[] = [
  { rank: 40, text: `When behavior changes, change its rule in the same commit (new rule: canon rule new --domain <domain> --title "..."). One rule = one testable behavior, with ## 规则 and ## 例子; tests name the rule they prove: it("BR-n: ...").` },
  { rank: 50, text: `Pick the domain by business capability, not by command name or technical layer: see canon rule domains; when none fits, create a subdomain (canon rule domain <domain>/<name>). Code lives in the matching directory, and the change file names the subdomain.` },
  { rank: 60, text: `A significant choice with real alternatives becomes a decision (canon decision new --title "..."), rejected options included.` },
];
