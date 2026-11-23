import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_LIMITS, memoryNow } from "../../kernel/machine.ts";
import { project, sh, ws } from "../testkit.ts";
import { readings } from "./capacity.ts";
import { roomOf } from "../reminders/room.ts";

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}.worktrees`, { recursive: true, force: true }); } });
const mac = (level: string) => ({ platform: "darwin" as const, sysctl: () => level, file: () => undefined });
const linux = (psi: number) => ({ platform: "linux" as const, sysctl: () => undefined, file: (p: string) => (p === "/proc/pressure/memory" ? `some avg10=${psi} avg60=0 avg300=0 total=0\n` : undefined) });

test("BR-2640 BR-2526: memory_tight_level critical makes macOS warn not tight, critical still tight; the default counts warn", () => {
  const critical = { ...MEMORY_LIMITS, memory_tight_level: "critical" as const };
  expect(memoryNow(mac("2"))!.tight).toBe(true);
  expect(memoryNow(mac("2"), critical)!.tight).toBe(false);
  expect(memoryNow(mac("4"), critical)!.tight).toBe(true);
  expect(readings({ CANON_MACHINE: "warn,1,8" }, critical).memory!.tight).toBe(false);
  expect(readings({ CANON_MACHINE: "warn,1,8" }).memory!.tight).toBe(true);
});

test("BR-2640: memory_psi_percent sets the Linux PSI limit and is said in the reading", () => {
  expect(memoryNow(linux(12))!.tight).toBe(true);
  const r = memoryNow(linux(12), { ...MEMORY_LIMITS, memory_psi_percent: 20 })!;
  expect(r.tight).toBe(false);
  expect(r.text).toContain("limit 20%");
});

test("BR-2640 BR-2581: full_run_load_share sets the load limit while a full test run is running", () => {
  const root = project(); roots.push(root);
  appendFileSync(join(root, "canon/config.yaml"), "policies:\n  capacity:\n    full_run_load_share: 0.5\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "policy");
  const read = { memory: { tight: false, text: "memory pressure normal" }, machine: { load5: 9, cpus: 8 } };
  const w = ws(root, "agent:s1");
  try {
    expect(roomOf(w, read, 0, 0).room).toBe(true);
    const busy = roomOf(w, read, 0, 1);
    expect(busy.room).toBe(false);
    expect(busy.limit).toBe(8);
  } finally { w.db.close(); }
});
