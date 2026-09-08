import { existsSync, readFileSync } from "node:fs";
import { LATEST_JSON_PATH } from "./config.js";
import type { GuardInput } from "./tasks.js";

export interface QuotaSnapshot {
  generatedAtMs: number | null;
  guard: GuardInput;
}

export function readQuotaSnapshot(nowMs: number, path: string = LATEST_JSON_PATH): QuotaSnapshot {
  const empty: GuardInput = {
    nowMs, sessionPct: null, sessionResetMs: null, weeklyPct: null, weeklyResetMs: null,
  };
  if (!existsSync(path)) return { generatedAtMs: null, guard: empty };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      generatedAtMs: number;
      providers: Record<string, { windows: Array<{
        windowKey: string; pct: number | null; resetEpochMs: number | null;
      }> }>;
    };
    const windows = j.providers["claude"]?.windows ?? [];
    const find = (key: string) => windows.find((w) => w.windowKey === key);
    const session = find("session_5h");
    const weekly = find("weekly_all");
    return {
      generatedAtMs: j.generatedAtMs,
      guard: {
        nowMs,
        sessionPct: session?.pct ?? null,
        sessionResetMs: session?.resetEpochMs ?? null,
        weeklyPct: weekly?.pct ?? null,
        weeklyResetMs: weekly?.resetEpochMs ?? null,
      },
    };
  } catch {
    return { generatedAtMs: null, guard: empty };
  }
}
