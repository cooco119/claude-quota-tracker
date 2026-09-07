import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DB_PATH, LATEST_JSON_PATH, loadConfig } from "./config.js";
import { loadPacingConfig } from "./pacing-config.js";
import { quotaPacingVerdict } from "./pacing.js";
import { executeTask } from "./executor.js";
import { Store } from "./store.js";
import type { GuardInput } from "./tasks.js";

interface LatestSnapshot {
  generatedAtMs: number | null;
  guard: GuardInput;
}

function readLatest(nowMs: number): LatestSnapshot {
  const empty: GuardInput = {
    nowMs,
    sessionPct: null,
    sessionResetMs: null,
    weeklyPct: null,
    weeklyResetMs: null,
  };
  if (!existsSync(LATEST_JSON_PATH)) return { generatedAtMs: null, guard: empty };
  try {
    const j = JSON.parse(readFileSync(LATEST_JSON_PATH, "utf8")) as {
      generatedAtMs: number;
      providers: Record<string, { windows: Array<{
        windowKey: string;
        pct: number | null;
        resetEpochMs: number | null;
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

export async function runPacedOnce(): Promise<boolean> {
  const config = loadConfig();
  const pacing = loadPacingConfig();
  const nowMs = Date.now();
  const latest = readLatest(nowMs);

  const verdict = quotaPacingVerdict({
    enabled: pacing.enabled,
    nowMs,
    sessionPct: latest.guard.sessionPct,
    sessionResetMs: latest.guard.sessionResetMs,
    weeklyPct: latest.guard.weeklyPct,
    weeklyResetMs: latest.guard.weeklyResetMs,
    sessionBudgetPct: config.executor.sessionGuardPct,
    weeklyBudgetPct: config.executor.weeklyGuardPct,
    slackPct: pacing.slackPct,
    sessionWindowMs: pacing.sessionWindowHours * 60 * 60 * 1000,
    weeklyWindowMs: pacing.weeklyWindowHours * 60 * 60 * 1000,
  });

  if (!verdict.ok) {
    console.log(`[paced-executor] hold: ${verdict.reason}`);
    return false;
  }

  const store = new Store(DB_PATH);
  try {
    const task = store.claimNextTask(nowMs);
    if (!task) {
      console.log("[paced-executor] no claimable task");
      return false;
    }
    console.log(`[paced-executor] task #${task.id} (${task.size}, ${task.permissionClass})`);
    return await executeTask(store, task, config, latest.guard);
  } finally {
    store.close();
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runPacedOnce().catch((e) => {
    console.error("[paced-executor] fatal:", e);
    process.exitCode = 1;
  });
}
