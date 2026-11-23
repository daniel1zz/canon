import { readFileSync } from "node:fs";

/**
 * The machine's memory pressure, read from the operating system's own signal (BR-2526, D-136): macOS's pressure level,
 * Linux's PSI, or Linux's MemAvailable share where PSI is missing. Swap free is not used: macOS grows swap on demand,
 * so its free space drops before every growth and says little (human #67).
 */
export interface Memory {
  readonly tight: boolean;
  /** What was read, the way a refusal prints it, e.g. `memory pressure warn` or `MemAvailable 8%`. */
  readonly text: string;
}

/** Where the readings come from; tests replace them. */
export interface MemorySources {
  readonly platform: NodeJS.Platform;
  /** `sysctl -n <name>`'s output, undefined when it cannot be run or fails. */
  readonly sysctl: (name: string) => string | undefined;
  /** A file's text, undefined when it cannot be read. */
  readonly file: (path: string) => string | undefined;
}

const sysctl = (name: string): string | undefined => {
  try {
    const r = Bun.spawnSync(["sysctl", "-n", name], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
};

const file = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const systemSources: MemorySources = { platform: process.platform, sysctl, file };

/**
 * When memory counts as tight (BR-2526), a project's policies.capacity (BR-2640): the macOS pressure level from which it
 * is tight, the Linux PSI `some avg10` percent at or over which it is, and the MemAvailable percent under which it is.
 */
export interface MemoryLimits {
  readonly memory_tight_level: "warn" | "critical";
  readonly memory_psi_percent: number;
  readonly memory_available_percent: number;
}
export const MEMORY_LIMITS: MemoryLimits = { memory_tight_level: "warn", memory_psi_percent: 10, memory_available_percent: 10 };

/** Whether a macOS pressure level name is tight under `limits` (BR-2640). */
export const levelTight = (name: string, limits: MemoryLimits): boolean => name === "critical" || (name === "warn" && limits.memory_tight_level === "warn");

const LEVELS: Readonly<Record<string, string>> = { "1": "normal", "2": "warn", "4": "critical" };

/** The memory reading now; undefined when this platform gives none or reading it failed (BR-2526: not measured). */
export function memoryNow(src: MemorySources = systemSources, limits: MemoryLimits = MEMORY_LIMITS): Memory | undefined {
  if (src.platform === "darwin") {
    const level = src.sysctl("kern.memorystatus_vm_pressure_level");
    const name = level === undefined ? undefined : LEVELS[level];
    if (name === undefined) return undefined;
    return { tight: levelTight(name, limits), text: `memory pressure ${name}` };
  }
  if (src.platform !== "linux") return undefined;
  const psi = src.file("/proc/pressure/memory")?.match(/^some avg10=([\d.]+)/m)?.[1];
  if (psi !== undefined) {
    const avg10 = Number(psi);
    return { tight: avg10 >= limits.memory_psi_percent, text: `memory pressure (PSI some avg10) ${avg10.toFixed(2)}%, limit ${limits.memory_psi_percent}%` };
  }
  const info = src.file("/proc/meminfo");
  const kb = (key: string) => Number(info?.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))?.[1] ?? NaN);
  const total = kb("MemTotal"), available = kb("MemAvailable");
  if (!(total > 0) || !(available >= 0)) return undefined;
  const share = available / total;
  return { tight: share * 100 < limits.memory_available_percent, text: `MemAvailable ${Math.round(share * 100)}% of MemTotal, limit ${limits.memory_available_percent}%` };
}
