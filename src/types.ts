export type WindowKey = "session_5h" | "weekly_all" | "weekly_sonnet";

export interface WindowReading {
  windowKey: WindowKey;
  /** Usage percent 0-100, null when the line could not be parsed. */
  pct: number | null;
  /** Reset time as epoch milliseconds, null when not parseable. */
  resetEpochMs: number | null;
  /** The raw line this reading was parsed from. Always preserved. */
  raw: string;
}

export interface UsageProvider {
  id: string;
  fetch(): Promise<WindowReading[]>;
}

/** Nominal duration of each window, used for linear-from-window-start fallback. */
export const WINDOW_DURATION_MS: Record<WindowKey, number> = {
  session_5h: 5 * 60 * 60 * 1000,
  weekly_all: 7 * 24 * 60 * 60 * 1000,
  weekly_sonnet: 7 * 24 * 60 * 60 * 1000,
};

// ---- Part B: task orchestration ----

export type TaskSize = "xs" | "s" | "m" | "l" | "xl";
export type PermissionClass = "read-only" | "write-scoped" | "destructive";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "carried_over";
export type ScheduledWindow = "night" | "any";

/** Naive size estimates shown at enqueue and recorded as the estimate side. */
export const SIZE_ESTIMATES: Record<TaskSize, { tokens: number; minutes: number }> = {
  xs: { tokens: 10_000, minutes: 5 },
  s: { tokens: 25_000, minutes: 10 },
  m: { tokens: 60_000, minutes: 20 },
  l: { tokens: 150_000, minutes: 40 },
  xl: { tokens: 400_000, minutes: 60 },
};

export interface TaskInput {
  prompt: string;
  cwd: string;
  size: TaskSize;
  priority: number;
  deferOk: boolean;
  permissionClass: PermissionClass;
  permissionMode: string;
  unattendedOk: boolean;
  scheduledWindow: ScheduledWindow;
}

export interface Task extends TaskInput {
  id: number;
  createdTs: number;
  updatedTs: number;
  status: TaskStatus;
  attempts: number;
  resumeSessionId: string | null;
  worktreePath: string | null;
  lastError: string | null;
}

/** Actuals extracted from one headless `claude -p --output-format json` run. */
export interface RunActuals {
  model: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  /** result JSON `subtype` ("success", "error_max_turns", …) or "error". */
  result: string;
  error: string | null;
  /** Raw result JSON preserved verbatim (schema-drift insurance). */
  rawJson: string | null;
}
