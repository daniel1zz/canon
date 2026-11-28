import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeClaim } from "../../work/claims/claims.ts";
import { processOf } from "../../work/claims/liveness.ts";
import { enter } from "../../work/land/queue/queue.ts";
import { ask } from "../../work/humans/questions.ts";
import { writeHandoff } from "../../work/session/handoffs.ts";
import { project, sh, startNew, ws } from "../../work/testkit.ts";
import { changeStates, type ChangeState } from "./state.ts";

// reason: several cases spawn canon or make worktrees; a loaded machine takes longer than bun's 5 s default
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { rmSync(r, { recursive: true, force: true }); rmSync(`${r}.worktrees`, { recursive: true, force: true }); } });

const MAIN = join(import.meta.dir, "..", "..", "invocation", "main.ts");
const cli = (cwd: string, actor: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: actor } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const HOUR = 3_600_000;
const BODY = "\n## 为什么\n\nx\n\n## 要改什么\n\nx\n";
const change = (n: number, status: string, extra = "", body = BODY) => `---\nid: C-${n}\ntitle: Change ${n}\nstatus: ${status}\n${extra.includes("rules:") ? "" : "rules: []\n"}${extra}---\n${body}`;
const rule = (id: string, status: string) => `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nbusiness: x\n---\n\n## 规则\n\nIt holds.\n\n## 例子\n\n- a → b\n`;
const release = `---\nid: R-2\ntitle: Release 2\nstatus: active\nfeatures: []\n---\n\n## 目标\n\nx\n\n## 用户\n\nx\n\n## 范围\n\nx\n\n## 不做\n\nx\n\n## 成功标准\n\n- S3 负责人逐条回答。（待负责人）\n\n## 故事地图切片\n\nx\n`;

/** A project whose main has canon/product.md, active BR-1, planned BR-2 and `files` (path under canon/ → text). */
function repo(files: Record<string, string>): string {
  const root = project(); roots.push(root);
  put(root, { "product.md": "# Product\n\nx\n", "rules/x/BR-1.md": rule("BR-1", "active"), "rules/x/BR-2.md": rule("BR-2", "planned"), ...files });
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "fixture");
  return root;
}
function put(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(root, "canon", p, ".."), { recursive: true }); writeFileSync(join(root, "canon", p), text); }
}
function states(root: string, now = Date.now()): Map<string, ChangeState> {
  const w = ws(root);
  try {
    const r = changeStates(w, { now });
    if (!r.ok) throw new Error(r.error.message);
    return new Map(r.value.states.map((s) => [s.id, s]));
  } finally { w.db.close(); }
}
const stateOf = (root: string, id: string, now?: number) => states(root, now).get(id)?.state;
function db<T>(root: string, f: (w: ReturnType<typeof ws>) => T): T { const w = ws(root); try { return f(w); } finally { w.db.close(); } }
const live = () => processOf(process.pid)!;
const claim = (root: string, id: string, actor = "agent:b") => db(root, (w) => { const r = takeClaim(w.db, id, `/wt/${id}`, actor, HOUR, live()); if (!r.ok) throw new Error(r.error.message); });
function delegateRow(root: string, id: string, worker = "w1"): void {
  db(root, (w) => {
    w.db.db.query("INSERT INTO delegations(subject,worker,owner,revision,epoch,acceptor,manifest,task_hash) VALUES (?, ?, 'agent:s1', 'x', 1, NULL, '[]', 'h')").run(id, worker);
    w.db.event("agent:s1", "delegation.create", id, { worker });
  });
}

describe("BR-2571: the primary state, by precedence, from facts only", () => {
  test("BR-2571: landed and dropped come from main; a branch-only change dropped since is dropped, not stalled; a delegation with no file and no drop is missing", () => {
    const root = repo({ "changes/C-1.md": change(1, "done"), "changes/C-2.md": change(2, "dropped") });
    delegateRow(root, "C-1");
    db(root, (w) => w.db.event("agent:a", "drop.done", "C-671", { branch: "change/C-671-x" }));
    delegateRow(root, "C-671");
    delegateRow(root, "C-9");
    const later = Date.now() + 2 * HOUR;
    const s = states(root, later);
    expect([s.get("C-1")?.state, s.get("C-2")?.state, s.get("C-671")?.state, s.get("C-9")?.state]).toEqual(["landed", "dropped", "dropped", "missing"]);
    expect(s.get("C-671")!.stalled).toBeUndefined();
    expect(s.get("C-671")!.change).toBeUndefined();
    // missing is not closed: its delegation is still a stall for the design owner (BR-2522)
    expect(s.get("C-9")!.stalled?.worker).toBe("w1");
  });

  test("BR-2571: open on main, no branch, no claim, started once, its rules all active: awaiting-close; a planned rule or never started: not", () => {
    const root = repo({
      "changes/C-343.md": change(343, "open", "rules: [BR-1]\n"),
      "changes/C-344.md": change(344, "open", "rules: [BR-1, BR-2]\n"),
      "changes/C-345.md": change(345, "open", "rules: [BR-1]\n"),
    });
    db(root, (w) => { w.db.event("agent:a", "claim.take", "C-343", {}); w.db.event("agent:a", "claim.take", "C-344", {}); });
    const s = states(root);
    expect(s.get("C-343")!.state).toBe("awaiting-close");
    expect(s.get("C-344")!.state).toBe("ready-delegatable");
    expect(s.get("C-345")!.state).toBe("ready-delegatable");
    claim(root, "C-343");
    expect(stateOf(root, "C-343")).toBe("in-progress");
  });

  test("BR-2571: in the landing queue beats a refusal; a refusal beats a live claim; a live claim is in-progress with its flags", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-2.md": change(2, "open"), "changes/C-3.md": change(3, "open") });
    db(root, (w) => {
      w.db.event("agent:a", "land.start", "C-1", {}); w.db.event("agent:a", "land.refuse", "C-1", { reason: "floor" });
      enter(w.db, "/wt/C-1", "C-1", "agent:a");
      w.db.event("agent:a", "land.start", "C-2", {}); w.db.event("agent:a", "land.refuse", "C-2", { reason: "floor" });
    });
    claim(root, "C-2"); claim(root, "C-3");
    db(root, (w) => writeHandoff(w.db, { subject: "C-3", worktree: null, actor: "agent:b", next: "go on", note: null, reason: "partial", on: null }));
    const s = states(root);
    expect(s.get("C-1")!.state).toBe("in-queue");
    expect(s.get("C-2")!.state).toBe("land-refused");
    expect(s.get("C-2")!.landRefusedAt).toBeDefined();
    expect(s.get("C-3")!.state).toBe("in-progress");
    expect(s.get("C-3")!.flags).toMatchObject({ claimed: true, handoff: true });
  });

  test("BR-2571 BR-2522: a delegation in force is delegated, and stalled once its worker is gone and no commit came for delegation_stall_minutes", () => {
    const root = repo({ "changes/C-5.md": change(5, "open") });
    delegateRow(root, "C-5");
    expect(stateOf(root, "C-5")).toBe("delegated");
    expect(stateOf(root, "C-5", Date.now() + 2 * HOUR)).toBe("stalled");
    expect(states(root, Date.now() + 2 * HOUR).get("C-5")!.delegation?.worker).toBe("w1");
  });

  test("BR-2571: waiting-owner only from an unanswered question about the change or an owner criterion; waiting-deps from other dependencies", () => {
    const root = repo({
      "releases/R-2.md": release,
      "changes/C-3.md": change(3, "open"),
      "changes/C-5.md": change(5, "open", "depends_on: [C-3]\n"),
      "changes/C-6.md": change(6, "open"),
      "changes/C-7.md": change(7, "open", "depends_on: [R-2/S3]\n"),
      "changes/C-8.md": change(8, "open"),
    });
    const q = db(root, (w) => { ask(w.db, "agent:a", null, "about nothing?", []); return ask(w.db, "agent:a", "C-6", "go on?", []); });
    const s = states(root);
    expect(s.get("C-5")!.state).toBe("waiting-deps");
    expect(s.get("C-5")!.flags.deps_unmet).toBe(true);
    expect(s.get("C-6")!.state).toBe("waiting-owner");
    expect(s.get("C-6")!.ownerQuestions).toEqual([q]);
    expect(s.get("C-6")!.flags.owner_question).toBe(true);
    expect(s.get("C-7")!.state).toBe("waiting-owner");
    // a question about no change frees or holds nothing
    expect(s.get("C-8")!.state).toBe("ready-delegatable");
    db(root, (w) => w.db.db.query("UPDATE questions SET answer = 'yes' WHERE id = ?").run(q));
    expect(stateOf(root, "C-6")).toBe("ready-delegatable");
  });

  test("BR-2571 BR-2025: a handoff is handed-off with its reason, an old one unrecorded; an owner handoff on an unanswered question is waiting-owner", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-2.md": change(2, "open"), "changes/C-3.md": change(3, "open") });
    const q = db(root, (w) => ask(w.db, "agent:a", "C-3", "resume?", []));
    db(root, (w) => {
      writeHandoff(w.db, { subject: "C-1", worktree: null, actor: "agent:b", next: "done, land it", note: null, reason: "land", on: null });
      writeHandoff(w.db, { subject: "C-2", worktree: null, actor: "agent:b", next: "old text", note: null, reason: null, on: null });
      writeHandoff(w.db, { subject: "C-3", worktree: null, actor: "agent:b", next: "wait", note: null, reason: "owner", on: `#${q}` });
    });
    const s = states(root);
    expect([s.get("C-1")!.state, s.get("C-1")!.handoff?.reason]).toEqual(["handed-off", "land"]);
    expect([s.get("C-2")!.state, s.get("C-2")!.handoff?.reason]).toEqual(["handed-off", null]);
    expect(s.get("C-3")!.state).toBe("waiting-owner");
  });

  test("BR-2571: ready splits into delegatable and self: empty task sections or a rule not on main make it ready-self with the reasons", () => {
    const root = repo({
      "changes/C-1.md": change(1, "open", "rules: [BR-1]\n"),
      "changes/C-7.md": change(7, "open", "", "\n## 为什么\n\n<要解决什么问题。>\n\n## 要改什么\n\n<具体改动。>\n"),
      "changes/C-8.md": change(8, "open", "rules: [BR-30]\n"),
    });
    const s = states(root);
    expect(s.get("C-1")!.state).toBe("ready-delegatable");
    expect(s.get("C-7")!.state).toBe("ready-self");
    expect(s.get("C-7")!.notDelegatable).toEqual(["## 为什么 is empty", "## 要改什么 is empty"]);
    expect(s.get("C-8")!.state).toBe("ready-self");
    expect(s.get("C-8")!.notDelegatable).toEqual(["BR-30 not on main"]);
  });
});

describe("BR-2572: canon change list gives each change's state, flags and what it waits for", () => {
  test("BR-2572 BR-2291: text marks start with the state; --json carries state, flags, owner questions, delegation and handoff reason; --all adds a branch-only change dropped since", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-5.md": change(5, "open", "depends_on: [C-3]\n"), "changes/C-3.md": change(3, "open"), "changes/C-6.md": change(6, "open", "", "\n## 为什么\n\nx\n") });
    const q = db(root, (w) => ask(w.db, "agent:a", "C-3", "go?", []));
    db(root, (w) => w.db.event("agent:a", "drop.done", "C-671", {}));
    delegateRow(root, "C-671");
    const text = cli(root, "agent:a", "change", "list");
    expect(text.code).toBe(0);
    expect(text.out).toContain("C-1      open       P2             Change 1  (ready-delegatable)"); // the tier column, BR-2603
    expect(text.out).toContain(`C-3      open       P2             Change 3  (waiting-owner: #${q})`);
    expect(text.out).toContain("(waiting-deps; waiting for C-3)");
    expect(text.out).toContain("(ready-self: ## 要改什么 is empty)");
    expect(text.out).not.toContain("C-671");
    const rows = JSON.parse(cli(root, "agent:a", "change", "list", "--json").out) as Record<string, unknown>[];
    const c3 = rows.find((r) => r["id"] === "C-3")!;
    expect(c3).toMatchObject({ state: "waiting-owner", owner_questions: [q], delegation: null, land_refused_at: null, not_delegatable: [] });
    expect(c3["flags"]).toEqual({ handoff: false, deps_unmet: false, owner_question: true, claimed: false, ambiguous: false, closed_on_branch: false, overlap: false });
    expect(rows.find((r) => r["id"] === "C-5")).toMatchObject({ state: "waiting-deps", dependsOn: ["C-3"], waiting_for: [{ id: "C-3", state: "open" }] });
    const all = JSON.parse(cli(root, "agent:a", "change", "list", "--all", "--json").out) as Record<string, unknown>[];
    expect(all.find((r) => r["id"] === "C-671")).toMatchObject({ title: null, status: null, state: "dropped" });
    expect(cli(root, "agent:a", "change", "list", "--all").out).toMatch(/^C-671 +\(no file\)  \(dropped\)$/m);
  });

  test("BR-2572 BR-2025: a handoff's reason and what it waits on are in --json; an old handoff reads unrecorded", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-2.md": change(2, "open") });
    db(root, (w) => {
      writeHandoff(w.db, { subject: "C-1", worktree: null, actor: "agent:b", next: "land it", note: null, reason: "land", on: null });
      writeHandoff(w.db, { subject: "C-2", worktree: null, actor: "agent:b", next: "old", note: null, reason: null, on: null });
    });
    const rows = JSON.parse(cli(root, "agent:a", "change", "list", "--json").out) as { id: string; handoff: { reason: string; on: string | null } }[];
    expect(rows.find((r) => r.id === "C-1")!.handoff).toMatchObject({ reason: "land", on: null });
    expect(rows.find((r) => r.id === "C-2")!.handoff).toMatchObject({ reason: "unrecorded" });
    expect(cli(root, "agent:a", "change", "list").out).toContain("(handed-off: unrecorded; handoff: old)");
  });

  test("BR-2575: canon change list ends with one line naming the handoffs with no recorded reason and the command that sets one; none when every handoff has one", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-2.md": change(2, "open") });
    db(root, (w) => writeHandoff(w.db, { subject: "C-1", worktree: null, actor: "agent:b", next: "land it", note: null, reason: "land", on: null }));
    expect(cli(root, "agent:a", "change", "list").out).not.toContain("handoff-reason");
    db(root, (w) => writeHandoff(w.db, { subject: "C-2", worktree: null, actor: "agent:b", next: "old", note: null, reason: null, on: null }));
    const lines = cli(root, "agent:a", "change", "list").out.trimEnd().split("\n");
    expect(lines.at(-1)).toBe("1 handoff(s) have no recorded reason (C-2): canon work handoff-reason <C-n> --reason <land|design|owner|deps|partial>");
    expect(cli(root, "agent:a", "change", "list", "--json").out).not.toContain("handoff-reason");
  });
});

describe("BR-2564 BR-2149: the brief keeps changes waiting on the owner or already on main off the line to take", () => {
  test("BR-2564: waiting-owner and awaiting-close changes are listed apart, not offered to take", () => {
    const root = repo({ "changes/C-1.md": change(1, "open"), "changes/C-6.md": change(6, "open"), "changes/C-343.md": change(343, "open", "rules: [BR-1]\n") });
    const q = db(root, (w) => { w.db.event("agent:a", "claim.take", "C-343", {}); return ask(w.db, "agent:a", "C-6", "go?", []); });
    const out = cli(root, "agent:a", "brief").out;
    const take = out.split("\n").find((l) => l.startsWith("Open changes in the owner's order"))!;
    expect(take).toContain("C-1");
    expect(take).not.toContain("C-6");
    expect(take).not.toContain("C-343");
    expect(out).toContain(`Waiting for the owner, not ready to start (ask them; canon human pending): C-6 (#${q})`);
    expect(out).toContain("Work already on main, close it instead of starting it (canon change close <C-n> --commit <commit>): C-343");
  });
});

describe("BR-2573: canon change close", () => {
  test("BR-2573: closes an open change with the main commit that carried its work; refuses a closed change, a commit off main or unknown, a missing change", () => {
    const root = repo({ "changes/C-343.md": change(343, "open", "rules: [BR-1]\n") });
    const carried = sh(root, "rev-parse", "main");
    sh(root, "branch", "side"); sh(root, "checkout", "-q", "side");
    writeFileSync(join(root, "side.txt"), "x\n"); sh(root, "add", "-A"); sh(root, "commit", "-qm", "side");
    const offMain = sh(root, "rev-parse", "HEAD");
    sh(root, "checkout", "-q", "main");
    expect(cli(root, "agent:a", "change", "close", "C-343", "--commit", offMain).code).toBe(3);
    expect(cli(root, "agent:a", "change", "close", "C-343", "--commit", "deadbeef").code).toBe(3);
    expect(cli(root, "agent:a", "change", "close", "C-343").code).toBe(2);
    expect(cli(root, "agent:a", "change", "close", "C-999", "--commit", carried).code).toBe(3);
    expect(readFileSync(join(root, "canon/changes/C-343.md"), "utf8")).toContain("status: open");
    const ok = cli(root, "agent:a", "change", "close", "C-343", "--commit", carried.slice(0, 8));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(`C-343 → done, landed in ${carried.slice(0, 9)}`);
    const text = readFileSync(join(root, "canon/changes/C-343.md"), "utf8");
    expect(text).toContain("status: done");
    expect(text).toContain(`landed_in: ${carried}`);
    expect(db(root, (w) => w.db.db.query<{ detail: string }, []>("SELECT detail FROM events WHERE kind = 'change.close'").get()?.detail)).toBe(JSON.stringify({ commit: carried }));
    expect(cli(root, "agent:a", "change", "close", "C-343", "--commit", carried).code).toBe(2);
  });

  test("BR-2573: landed_in on a change that is not done is file-invalid in canon check", () => {
    const root = repo({ "changes/C-1.md": change(1, "open", "landed_in: 0123456789abcdef0123456789abcdef01234567\n") });
    const out = cli(root, "agent:a", "check").out;
    expect(out).toMatch(/file-invalid\s+canon\/changes\/C-1\.md.*landed_in/);
  });
});

describe("BR-2574: dropping a change ends its delegation", () => {
  test("BR-2574 BR-2522: canon work drop of a delegated branch-only change ends the delegation; it is no stall in status or due", () => {
    const root = repo({});
    const s = startNew(root, "Branch only", "agent:s1");
    sh(s.worktree, "commit", "-q", "--allow-empty", "-m", "wip");
    db(root, (w) => w.db.db.query("DELETE FROM claims WHERE subject = ?").run(s.change));
    delegateRow(root, s.change);
    const dropped = cli(root, "agent:s1", "work", "drop", s.change);
    expect(dropped.code).toBe(0);
    expect(db(root, (w) => w.db.db.query<{ ended: string | null }, [string]>("SELECT ended FROM delegations WHERE subject = ?").get(s.change)?.ended)).not.toBeNull();
    expect(db(root, (w) => w.db.db.query<{ detail: string }, [string]>("SELECT detail FROM events WHERE kind = 'delegation.end' AND subject = ?").get(s.change)?.detail)).toContain("canon work drop");
    expect(cli(root, "agent:s1", "work", "status").out).not.toContain("stalled");
    expect(cli(root, "agent:s1", "work", "due").out).not.toContain(`stalled:${s.change}`);
  });

  test("BR-2574: canon change drop ends the delegation; with no delegation nothing more is written", () => {
    const root = repo({ "changes/C-6.md": change(6, "open"), "changes/C-7.md": change(7, "open") });
    delegateRow(root, "C-6", "w2");
    const r = cli(root, "agent:s1", "change", "drop", "C-6");
    expect(r.code).toBe(0);
    expect(r.out).toContain("C-6: its delegation ended");
    expect(cli(root, "agent:s1", "change", "drop", "C-7").code).toBe(0);
    const ends = db(root, (w) => w.db.db.query<{ subject: string }, []>("SELECT subject FROM events WHERE kind = 'delegation.end'").all().map((e) => e.subject));
    expect(ends).toEqual(["C-6"]);
  });
});

describe("BR-2025 BR-2575: a handoff's reason", () => {
  test("BR-2025: canon work stop needs one of five reasons; owner needs --on a question about this change or a criterion on main", () => {
    const root = repo({ "releases/R-2.md": release });
    const s = startNew(root, "Stops", "agent:a");
    const other = db(root, (w) => ask(w.db, "agent:a", "C-999", "elsewhere?", []));
    const mine = db(root, (w) => ask(w.db, "agent:a", s.change, "resume?", []));
    const stop = (...args: string[]) => cli(s.worktree, "agent:a", "work", "stop", "--next", "next step", ...args);
    expect(stop().code).toBe(2);
    expect(stop("--reason", "waiting").code).toBe(2);
    expect(stop("--reason", "owner").code).toBe(2);
    expect(stop("--reason", "partial", "--on", String(mine)).code).toBe(2);
    const wrong = stop("--reason", "owner", "--on", String(other));
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain(`canon human ask --change ${s.change}`);
    expect(stop("--reason", "owner", "--on", "R-2/S9").code).toBe(3);
    expect(db(root, (w) => w.db.db.query("SELECT 1 FROM handoffs").get())).toBeNull();
    expect(stop("--reason", "owner", "--on", `#${mine}`).code).toBe(0);
    expect(db(root, (w) => w.db.db.query<{ reason: string; on_ref: string }, []>("SELECT reason, on_ref FROM handoffs").get())).toEqual({ reason: "owner", on_ref: `#${mine}` });
    expect(stop("--reason", "owner", "--on", "r-2/s3").code).toBe(0);
    expect(stop("--reason", "land").code).toBe(0);
    expect(db(root, (w) => w.db.db.query<{ reason: string; on_ref: string | null }, []>("SELECT reason, on_ref FROM handoffs").get())).toEqual({ reason: "land", on_ref: null });
    expect(cli(root, "agent:a", "work", "status").out).toContain(`${s.change.padEnd(8)} land: next: next step`);
  });

  test("BR-2575: canon work handoff-reason migrates an old handoff without a claim; no handoff is exit 3, a bad reason exit 2", () => {
    const root = repo({ "changes/C-406.md": change(406, "open"), "changes/C-5.md": change(5, "open") });
    db(root, (w) => writeHandoff(w.db, { subject: "C-406", worktree: "/gone", actor: "agent:b", next: "等负责人恢复招降", note: null, reason: null, on: null }));
    const q = db(root, (w) => ask(w.db, "agent:a", "C-406", "恢复招降？", []));
    expect(cli(root, "agent:a", "work", "handoff-reason", "C-406", "--reason", "waiting").code).toBe(2);
    expect(cli(root, "agent:a", "work", "handoff-reason", "C-5", "--reason", "land").code).toBe(3);
    const r = cli(root, "agent:a", "work", "handoff-reason", "C-406", "--reason", "owner", "--on", String(q));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`C-406: handoff reason owner #${q}`);
    expect(db(root, (w) => w.db.db.query<{ next: string; reason: string; on_ref: string }, []>("SELECT next, reason, on_ref FROM handoffs WHERE subject = 'C-406'").get())).toEqual({ next: "等负责人恢复招降", reason: "owner", on_ref: `#${q}` });
    expect(db(root, (w) => w.db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'handoff.reason'").get()?.n)).toBe(1);
    expect(stateOf(root, "C-406")).toBe("waiting-owner");
  });
});

test("BR-2526 BR-2571: a delegation of a branch-only change dropped before BR-2574 holds no worker slot", () => {
  const root = repo({ "config.yaml": "floor: test ! -e FAIL\ntests: []\nreview: none\ndelegate_max_workers: 1\n", "changes/C-1.md": change(1, "open") });
  db(root, (w) => w.db.event("agent:a", "drop.done", "C-671", {}));
  delegateRow(root, "C-671", "w0");
  const r = Bun.spawnSync(["bun", MAIN, "work", "delegate", "C-1", "--to", "w1"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, CANON_ACTOR: "agent:s1", CANON_MACHINE: "normal,0.1,8" } });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test("BR-2497 BR-2571: canon work status no longer lists the delegation record of a branch-only change dropped before BR-2574; an open change's record it lists", () => {
  const root = repo({ "changes/C-1.md": change(1, "open") });
  db(root, (w) => w.db.event("agent:a", "drop.done", "C-671", {}));
  delegateRow(root, "C-671", "w0");
  delegateRow(root, "C-1", "w1");
  const out = cli(root, "agent:s1", "work", "status").out;
  expect(out).not.toContain("C-671: delegated to w0");
  expect(out).toContain("C-1: delegated to w1");
});
