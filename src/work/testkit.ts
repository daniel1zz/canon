import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace, type Workspace } from "./workspace.ts";
import { git } from "../kernel/git.ts";
import { start } from "./session/session.ts";

/** Fixtures shared by the work and hook tests: throwaway repositories and workspaces. */
export const quiet = () => {};
export const FAST = { finish: false, timeoutMs: 20_000 };

export function sh(cwd: string, ...args: string[]) {
  const r = git(cwd, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** A repo whose floor passes unless a file named FAIL exists in the tree. */
export function project(): string {
  const root = mkdtempSync(join(tmpdir(), "canon-next-work-"));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  mkdirSync(join(root, "canon"), { recursive: true });
  writeFileSync(join(root, "canon/config.yaml"), "floor: test ! -e FAIL\ntests: []\n");
  writeFileSync(join(root, "app.txt"), "one\ntwo\nthree\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "init");
  return root;
}

export function ws(cwd: string, actor = "agent:a"): Workspace {
  process.env["CANON_ACTOR"] = actor;
  const r = openWorkspace(cwd);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Starts a change and fills its required sections, as an agent must before landing (BR-2035, BR-2091). */
export function startNew(root: string, title: string, actor = "agent:a") {
  const r = start(ws(root, actor), { title }, quiet);
  if (!r.ok) throw new Error(r.error.message);
  const dir = join(r.value.worktree, "canon/changes");
  const file = readdirSync(dir).find((f) => f.startsWith(`${r.value.change}-`) || f === `${r.value.change}.md`)!;
  const text = readFileSync(join(dir, file), "utf8");
  writeFileSync(join(dir, file), text.slice(0, text.indexOf("---\n", 4) + 4) + `\n## 为什么\n\n${title}.\n\n## 要改什么\n\n${title}.\n\n## 教训\n\n无。\n\n## 任务\n\n- [ ] ${title}\n`);
  sh(r.value.worktree, "commit", "-q", "--amend", "--no-edit", "-a");
  return r.value;
}


/**
 * A reference-transaction hook that, the first time a ref of `wt` moves to `to`, runs `git commit -qam fix` in `wt`
 * right then, as a session committing in the worktree at that moment would; returns the file its output goes to.
 */
export function gapCommit(root: string, wt: string, to: string): string {
  const hooks = join(sh(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks");
  mkdirSync(hooks, { recursive: true });
  const out = join(root, "..", `${root.split("/").pop()}-gap-commit`);
  writeFileSync(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q " ${to} " || exit 0\n[ -e ${out} ] && exit 0\ncd ${wt} && env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE git commit -qam fix > ${out} 2>&1\necho "exit $?" >> ${out}\n`,
    { mode: 0o755 },
  );
  return out;
}
