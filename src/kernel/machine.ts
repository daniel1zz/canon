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

/** The PSI `some avg10` at or over which Linux memory counts as tight (BR-2526). */
export const PSI_TIGHT = 10;
/** The MemAvailable share of MemTotal under which Linux memory counts as tight when there is no PSI (BR-2526). */
export const AVAILABLE_TIGHT = 0.1;

const LEVELS: Readonly<Record<string, string>> = { "1": "normal", "2": "warn", "4": "critical" };

/** The memory reading now; undefined when this platform gives none or reading it failed (BR-2526: not measured). */
export function memoryNow(src: MemorySources = systemSources): Memory | undefined {
  if (src.platform === "darwin") {
    const level = src.sysctl("kern.memorystatus_vm_pressure_level");
    const name = level === undefined ? undefined : LEVELS[level];
    if (name === undefined) return undefined;
    return { tight: level !== "1", text: `memory pressure ${name}` };
  }
  if (src.platform !== "linux") return undefined;
  const psi = src.file("/proc/pressure/memory")?.match(/^some avg10=([\d.]+)/m)?.[1];
  if (psi !== undefined) {
    const avg10 = Number(psi);
    return { tight: avg10 >= PSI_TIGHT, text: `memory pressure (PSI some avg10) ${avg10.toFixed(2)}%, limit ${PSI_TIGHT}%` };
  }
  const info = src.file("/proc/meminfo");
  const kb = (key: string) => Number(info?.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"))?.[1] ?? NaN);
  const total = kb("MemTotal"), available = kb("MemAvailable");
  if (!(total > 0) || !(available >= 0)) return undefined;
  const share = available / total;
  return { tight: share < AVAILABLE_TIGHT, text: `MemAvailable ${Math.round(share * 100)}% of MemTotal, limit ${AVAILABLE_TIGHT * 100}%` };
}
