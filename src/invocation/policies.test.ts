import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { configSchema, viewConfig } from "./reference/reference.ts";

/** A directory whose canon/config.yaml is `yaml`. */
function root(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "canon-policies-"));
  mkdirSync(join(dir, "canon"), { recursive: true });
  writeFileSync(join(dir, "canon/config.yaml"), yaml);
  return dir;
}
const read = (yaml: string) => readConfig(root(yaml));
const message = (yaml: string) => { const r = read(yaml); if (r.ok) throw new Error("expected a configuration error"); return r.error.message; };

test("BR-2638: without policies every group has its defaults; a group given in part keeps the defaults of what it leaves out", () => {
  const none = read("floor: 'true'\n");
  if (!none.ok) throw new Error(none.error.message);
  expect(none.value.agendaPolicy).toEqual({ slow_hours: 6, slow_test_failures: 4, interrupt_tiers: ["P0", "P1"], flaky_days: 7 });
  expect(none.value.capacityPolicy.full_run_load_share).toBe(0.9);
  expect(none.value.checkPolicy["rule-no-example"]).toBe("refuse");
  const part = read("policies:\n  agenda:\n    slow_hours: 12\n  capacity: null\n");
  if (!part.ok) throw new Error(part.error.message);
  expect(part.value.agendaPolicy).toMatchObject({ slow_hours: 12, slow_test_failures: 4 });
  expect(part.value.capacityPolicy.memory_tight_level).toBe("warn");
});

test("BR-2638: an unknown group or entry, a group that is no mapping, policies that is no mapping and a bad value are configuration errors naming the full key", () => {
  expect(message("policies:\n  agend: {}\n")).toContain("unknown policy group `policies.agend` (known: ");
  expect(message("policies:\n  agend: {}\n")).toContain("agenda");
  expect(message("policies:\n  agenda:\n    slow_hourz: 3\n")).toContain("unknown entry `policies.agenda.slow_hourz`");
  expect(message("policies:\n  agenda:\n    slow_hours: -1\n")).toContain("`policies.agenda.slow_hours` must be a positive number");
  expect(message("policies: [agenda]\n")).toContain("`policies` must be a mapping");
  expect(message("policies:\n  agenda: 3\n")).toContain("`policies.agenda` must be a mapping");
  expect(message("policies:\n  agenda:\n    flaky_days: 0\n")).toStartWith("canon/config.yaml: ");
});

test("BR-2638: canon config lists each group as policies.<group>, and the editor schema puts the groups under policies", () => {
  const views = viewConfig(root("policies:\n  agenda:\n    slow_hours: 12\n"));
  expect(views.find((v) => v.key === "policies.agenda")).toMatchObject({ set: true, value: { slow_hours: 12 } });
  expect(views.find((v) => v.key === "policies.checks")).toMatchObject({ set: false });
  const schema = configSchema() as { properties: Record<string, { properties?: Record<string, unknown> }> };
  expect(Object.keys(schema.properties["policies"]!.properties!).sort()).toEqual(["agenda", "capacity", "checks", "landing"]);
  expect(Object.keys(schema.properties).some((k) => k.includes("."))).toBe(false);
});

test("BR-2639: policies.agenda takes tiers from P0 to P3 only and a whole number of failures; BR-2640: capacity takes warn or critical, percents and a share", () => {
  expect(message("policies:\n  agenda:\n    interrupt_tiers: [P5]\n")).toContain("`policies.agenda.interrupt_tiers` must be a list of tiers");
  expect(message("policies:\n  agenda:\n    slow_test_failures: 1.5\n")).toContain("`policies.agenda.slow_test_failures` must be a whole number");
  expect(message("policies:\n  capacity:\n    memory_tight_level: high\n")).toContain("`policies.capacity.memory_tight_level` must be one of warn, critical");
  expect(message("policies:\n  capacity:\n    full_run_load_share: 1.5\n")).toContain("`policies.capacity.full_run_load_share` must be a share");
  expect(message("policies:\n  capacity:\n    memory_psi_percent: 0\n")).toContain("must be a percent");
  const ok = read("policies:\n  agenda:\n    interrupt_tiers: []\n");
  expect(ok.ok && ok.value.agendaPolicy.interrupt_tiers).toEqual([]);
});
