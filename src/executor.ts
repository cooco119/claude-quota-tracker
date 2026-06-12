import {
  existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATA_DIR, DB_PATH, LATEST_JSON_PATH, loadConfig,
  type Config, type ExecutorConfig,
} from "./config.js";
import { sendMacNotification } from "./notify.js";
import { addWorktree, runClaudeTask, type RunDeps } from "./runner.js";
import { Store } from "./store.js";
import {
  bestNightStartMs, currentTimezone, isLatestFresh, msUntilWindowEnd,
  shouldRunExecutor, windowGuard, type GuardInput,
} from "./tasks.js";
import type { Task } from "./types.js";

/**
 * Freshly claimed tasks are skipped by stale recovery for this long: there is
 * a window between claim (status=running) and the run row insert during which
 * the task would otherwise look dead — recovering it then double-runs it.
 */
const RECOVER_GRACE_MS = 2 * 60 * 1000;
const LOCK_PATH = join(DATA_DIR, "executor.lock");

interface LatestSnapshot {
  generatedAtMs: number | null;
  guard: GuardInput;
}

function readLatest(nowMs: number): LatestSnapshot {
  const empty: GuardInput = {
    nowMs, sessionPct: null, sessionResetMs: null, weeklyPct: null, weeklyResetMs: null,
  };
  if (!existsSync(LATEST_JSON_PATH)) return { generatedAtMs: null, guard: empty };
  try {
    const j = JSON.parse(readFileSync(LATEST_JSON_PATH, "utf8")) as {
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

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function settleUnfinished(
  store: Store, nowMs: number, task: Task, cfg: ExecutorConfig, error: string,
): void {
  store.settleTask({
    ts: nowMs,
    taskId: task.id,
    status: task.attempts >= cfg.maxAttempts ? "failed" : "carried_over",
    lastError: error,
  });
}

/**
 * Recover running tasks whose process died (crash/reboot). Three protections
 * against recovering a task that is actually alive:
 *  - grace period after claim (run row may not exist yet),
 *  - live pid with an unfinished run row is trusted,
 *  - unless it has overrun its size timeout by 1.5x (pid-reuse false-alive).
 * Recovery honors maxAttempts so crash-looping tasks terminate in `failed`.
 */
export function recoverStaleRunning(store: Store, nowMs: number, cfg: ExecutorConfig): void {
  for (const task of store.listTasks(["running"])) {
    if (nowMs - task.updatedTs < RECOVER_GRACE_MS) continue;
    const run = store.latestRunForTask(task.id);
    if (run && run.endedTs === null && isPidAlive(run.pid)) {
      const timeoutMs = (cfg.taskTimeoutMinutes[task.size] ?? 60) * 60 * 1000;
      if (nowMs - run.startedTs <= timeoutMs * 1.5) continue; // genuinely alive
    }
    settleUnfinished(store, nowMs, task, cfg, "stale running task recovered (process died)");
  }
}

/** Run one claimed task end to end: run row first, then worktree, claude, settle. */
export async function executeTask(
  store: Store,
  task: Task,
  config: Config,
  guard: GuardInput,
  deps: RunDeps = {},
): Promise<boolean> {
  const nowMs = Date.now();
  // The run row goes in before any slow work so stale recovery can see a live pid.
  const runId = store.startRun({
    ts: nowMs,
    taskId: task.id,
    pid: process.pid,
    sizeAtRun: task.size,
    sessionPctBefore: guard.sessionPct,
    weeklyPctBefore: guard.weeklyPct,
  });

  const failRun = (error: string): false => {
    store.finishRun(runId, Date.now(), {
      model: null, sessionId: null, inputTokens: null, outputTokens: null,
      cacheCreationTokens: null, cacheReadTokens: null, totalCostUsd: null,
      durationMs: null, result: "error", error, rawJson: null,
    });
    settleUnfinished(store, Date.now(), task, config.executor, error);
    return false;
  };

  let cwd = task.cwd;
  let worktreePath: string | null = null;
  if (task.permissionClass === "write-scoped") {
    worktreePath = join(DATA_DIR, "worktrees", `task-${task.id}-${nowMs}`);
    mkdirSync(join(DATA_DIR, "worktrees"), { recursive: true });
    try {
      await addWorktree(task.cwd, worktreePath, deps.exec);
      cwd = worktreePath;
    } catch (e) {
      return failRun(`worktree setup failed: ${(e as Error).message}`);
    }
  }

  const timeoutMs = (config.executor.taskTimeoutMinutes[task.size] ?? 60) * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failRun(`invalid timeout for size ${task.size}`);
  }

  const { actuals, success } = await runClaudeTask(task, cwd, timeoutMs, deps);
  store.finishRun(runId, Date.now(), actuals);
  store.settleTask({
    ts: Date.now(),
    taskId: task.id,
    status: success
      ? "done"
      : task.attempts >= config.executor.maxAttempts ? "failed" : "carried_over",
    resumeSessionId: actuals.sessionId,
    worktreePath,
    lastError: success ? null : actuals.error ?? `run result: ${actuals.result}`,
  });
  return success;
}

/** O_EXCL lockfile so two pollOnce calls cannot spawn two night loops. */
function acquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const holder = Number(readFileSync(LOCK_PATH, "utf8"));
        if (isPidAlive(holder)) return false;
        unlinkSync(LOCK_PATH); // stale lock from a dead executor
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    if (Number(readFileSync(LOCK_PATH, "utf8")) === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // already gone
  }
}

/** Night loop: re-evaluate gates before every claim, drain until blocked. */
export async function runNightLoop(deps: RunDeps = {}): Promise<void> {
  const config = loadConfig();
  if (!acquireLock()) {
    console.log("[executor] another executor holds the lock; exiting");
    return;
  }
  const store = new Store(DB_PATH);
  try {
    recoverStaleRunning(store, Date.now(), config.executor);
    for (;;) {
      const nowMs = Date.now();
      const latest = readLatest(nowMs);
      const verdict = shouldRunExecutor({
        nowMs,
        config,
        currentTz: currentTimezone(),
        latestGeneratedAtMs: latest.generatedAtMs,
        guard: latest.guard,
        hasClaimableTask: store.hasClaimableTask(),
        hasLiveRunningTask: store.listTasks(["running"]).length > 0,
      });
      if (!verdict.ok) {
        console.log(`[executor] stop: ${verdict.reason}`);
        return;
      }
      // Window fit: don't start a task whose timeout outlives the night window.
      const next = store.peekNextTask();
      if (next) {
        const fitMs = (config.executor.taskTimeoutMinutes[next.size] ?? 60) * 60 * 1000;
        if (msUntilWindowEnd(nowMs, config.nightWindow) < fitMs) {
          console.log(
            `[executor] stop: task #${next.id} (${next.size}) does not fit before window end`,
          );
          return;
        }
        // Deferrable night tasks hold until the night's lowest-usage hour.
        if (next.scheduledWindow === "night") {
          const best = bestNightStartMs({
            nowMs,
            nightWindow: config.nightWindow,
            history: store.history("claude", "session_5h", nowMs - 14 * 24 * 60 * 60 * 1000),
            minDays: config.executor.lowUsageMinDays,
            floorHHMM: config.executor.nightFloorHHMM,
          });
          if (nowMs < best.startMs) {
            const mins = Math.round((best.startMs - nowMs) / 60000);
            console.log(
              `[executor] stop: holding for low-usage hour ${best.hour}:00 ` +
              `(${best.reason}, ~${mins}m)`,
            );
            return;
          }
        }
      }
      const task = store.claimNextTask(nowMs);
      if (!task) return;
      console.log(`[executor] task #${task.id} (${task.size}, ${task.permissionClass})`);
      const ok = await executeTask(store, task, config, latest.guard, deps);
      console.log(`[executor] task #${task.id} ${ok ? "done" : "not done (carried over/failed)"}`);
    }
  } finally {
    store.close();
    releaseLock();
  }
}

/**
 * Manual attended run of one specific task (`--task <id>`): bypasses the
 * night-window gates (the user is watching) but still respects the window
 * guard, and records through the same estimation path.
 */
export async function runManualTask(id: number, deps: RunDeps = {}): Promise<boolean> {
  const config = loadConfig();
  const store = new Store(DB_PATH);
  try {
    const nowMs = Date.now();
    const latest = readLatest(nowMs);
    if (
      latest.generatedAtMs === null ||
      !isLatestFresh(latest.generatedAtMs, nowMs, config.pollIntervalSeconds)
    ) {
      console.warn("[executor] warning: latest.json stale — guard uses old usage data");
    }
    const guardVerdict = windowGuard(latest.guard, config.executor);
    if (!guardVerdict.ok) {
      console.error(`[executor] window guard: ${guardVerdict.reason}`);
      return false;
    }
    const task = store.claimTaskById(nowMs, id);
    if (!task) {
      console.error(`[executor] task #${id} not found or not runnable`);
      return false;
    }
    return await executeTask(store, task, config, latest.guard, deps);
  } finally {
    store.close();
  }
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const taskFlag = process.argv.indexOf("--task");
  const entry = taskFlag !== -1
    ? runManualTask(Number(process.argv[taskFlag + 1]))
    : runNightLoop();
  entry.catch(async (e) => {
    console.error("[executor] fatal:", e);
    await sendMacNotification({
      mode: "underUse", windowKey: "session_5h",
      title: "quota-tracker executor error",
      message: String(e).slice(0, 200),
    });
    process.exitCode = 1;
  });
}
