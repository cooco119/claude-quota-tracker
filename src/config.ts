import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "./sea.js";
import type { TaskSize } from "./types.js";

export interface QuietHours {
  /** "HH:MM" local time. Range may cross midnight (e.g. 23:00-08:00). */
  start: string;
  end: string;
}

export interface NotifyConfig {
  underUse: { enabled: boolean; thresholdPct: number };
  overUse: { enabled: boolean; thresholdPct: number };
  scheduleHint: { enabled: boolean };
  /** Minimum minutes between repeated nudges for the same window+mode. */
  cooldownMinutes: number;
  quietHours: QuietHours | null;
  /** Under-use only fires after this fraction of the window has elapsed. */
  minElapsedFraction: number;
}

export interface NightWindow {
  /** "HH:MM" local wall-clock, same semantics as QuietHours (may cross midnight). */
  start: string;
  end: string;
  /** ISO timestamp of the one-time user confirmation. null = night dispatch refused. */
  confirmedAt: string | null;
  /** IANA timezone at confirmation; mismatch with current tz requires re-confirmation. */
  confirmedTz: string | null;
}

export interface ExecutorConfig {
  enabled: boolean;
  /** Session window is the binding constraint: pause until reset at/above this pct. */
  sessionGuardPct: number;
  /** Weekly window is the fill target — guard leniently, near-exhaustion only. */
  weeklyGuardPct: number;
  /** Tasks exceeding this many attempts go to terminal `failed` instead of carrying over. */
  maxAttempts: number;
  /** Per-size execFile timeout in minutes. */
  taskTimeoutMinutes: Record<TaskSize, number>;
  /** Days of history required before --night tasks target the lowest-usage hour. */
  lowUsageMinDays: number;
  /**
   * Earliest local time (HH:MM) a night task may run. The night window opens at
   * 23:00, but execution holds until this floor (default 02:00 — the deepest
   * part of the night) so tasks don't fire while you may still be working.
   */
  nightFloorHHMM: string;
}

export interface DashboardConfig {
  /** Localhost port for the dashboard server. */
  port: number;
  /** Self-exit after this many idle minutes (0 = stay up until killed). */
  idleShutdownMin: number;
}

export interface Config {
  pollIntervalSeconds: number;
  notify: NotifyConfig;
  nightWindow: NightWindow;
  executor: ExecutorConfig;
  dashboard: DashboardConfig;
}

export const DEFAULT_CONFIG: Config = {
  pollIntervalSeconds: 300,
  notify: {
    underUse: { enabled: true, thresholdPct: 80 },
    overUse: { enabled: false, thresholdPct: 100 },
    scheduleHint: { enabled: false },
    cooldownMinutes: 120,
    quietHours: { start: "23:00", end: "08:00" },
    minElapsedFraction: 0.25,
  },
  nightWindow: {
    // Defaults derived from notify.quietHours; independently overridable.
    start: "23:00",
    end: "08:00",
    confirmedAt: null,
    confirmedTz: null,
  },
  executor: {
    enabled: true,
    sessionGuardPct: 80,
    weeklyGuardPct: 95,
    maxAttempts: 3,
    taskTimeoutMinutes: { xs: 5, s: 10, m: 20, l: 40, xl: 60 },
    lowUsageMinDays: 3,
    nightFloorHHMM: "02:00",
  },
  dashboard: {
    port: 47600,
    idleShutdownMin: 0,
  },
};

/**
 * Root for config.json and data/. Dev runs (node dist/*.js) stay repo-relative;
 * the baked `quota` binary uses ~/.quota-tracker. QUOTA_TRACKER_HOME overrides both.
 */
export const PROJECT_ROOT =
  process.env.QUOTA_TRACKER_HOME ??
  (isSea()
    ? join(homedir(), ".quota-tracker")
    : join(dirname(fileURLToPath(import.meta.url)), ".."));

/** Claude Code session logs — source for total-usage ingestion. */
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const DB_PATH = join(DATA_DIR, "quota.db");
export const LATEST_JSON_PATH = join(DATA_DIR, "latest.json");
export const NOTIFY_STATE_PATH = join(DATA_DIR, "notify-state.json");
export const CONFIG_PATH = join(PROJECT_ROOT, "config.json");

/** Load config.json over defaults (shallow per-section merge). */
export function loadConfig(path: string = CONFIG_PATH): Config {
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return DEFAULT_CONFIG;
  }
  const notify = { ...DEFAULT_CONFIG.notify, ...(raw.notify ?? {}) };
  return {
    pollIntervalSeconds:
      raw.pollIntervalSeconds ?? DEFAULT_CONFIG.pollIntervalSeconds,
    notify,
    nightWindow: {
      // Absent nightWindow start/end derive from quietHours, not the constant.
      start: notify.quietHours?.start ?? DEFAULT_CONFIG.nightWindow.start,
      end: notify.quietHours?.end ?? DEFAULT_CONFIG.nightWindow.end,
      confirmedAt: null,
      confirmedTz: null,
      ...(raw.nightWindow ?? {}),
    },
    executor: {
      ...DEFAULT_CONFIG.executor,
      ...(raw.executor ?? {}),
      // One level deeper: a partial override must not leave sizes undefined
      // (an undefined timeout would become NaN and kill the executor).
      taskTimeoutMinutes: {
        ...DEFAULT_CONFIG.executor.taskTimeoutMinutes,
        ...(raw.executor?.taskTimeoutMinutes ?? {}),
      },
    },
    dashboard: { ...DEFAULT_CONFIG.dashboard, ...(raw.dashboard ?? {}) },
  };
}

/**
 * Patch top-level sections of config.json in place: read-modify-write so user
 * keys we don't know about survive, tmp+rename so a concurrent loadConfig
 * never sees a half-written file.
 */
export function saveConfigPatch(
  patch: Partial<Record<keyof Config, unknown>>,
  path: string = CONFIG_PATH,
): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // missing/corrupt file: start from the patch alone
  }
  const next = { ...raw, ...patch };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, path);
}
