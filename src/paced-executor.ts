import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, DB_PATH, loadConfig } from "./config.js";
import { executeTask, recoverStaleRunning } from "./executor.js";
import { estimateTaskTokens } from "./adaptive-estimate.js";
import { loadPacingConfig } from "./pacing-config.js";
import { quotaPacingVerdict } from "./pacing.js";
import { readQuotaSnapshot } from "./quota-state.js";
import { SchedulerMetaStore } from "./scheduler-meta.js";
import { admitTask, compareScheduledTasks, continuousEligible } from "./scheduler-policy.js";
import { Store } from "./store.js";
import {
  currentTimezone, inNightWindow, isLatestFresh, msUntilWindowEnd,
  nightWindowConfirmed, windowGuard,
} from "./tasks.js";
import { SIZE_ESTIMATES, type Task } from "./types.js";

const LOCK_PATH = join(DATA_DIR, "paced-executor.lock");

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(): boolean {
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" }); return true; }
    catch {
      try {
        const pid = Number(readFileSync(LOCK_PATH, "utf8"));
        if (isPidAlive(pid)) return false;
        unlinkSync(LOCK_PATH);
      } catch { return false; }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    if (Number(readFileSync(LOCK_PATH, "utf8")) === process.pid) unlinkSync(LOCK_PATH);
  } catch { /* already gone */ }
}

function taskFitsNight(task: Task, nowMs: number, end: string, timeoutMinutes: number): boolean {
  return timeoutMinutes * 60_000 <= msUntilWindowEnd(nowMs, { end });
}

/**
 * Run at most one task. Re-running admission before each task is intentional:
 * the poller/daemon invokes this repeatedly, so quota is refreshed between
 * tasks instead of draining the queue from one stale percentage snapshot.
 */
export async function runPacedOnce(): Promise<boolean> {
  const config = loadConfig();
  const pacingCfg = loadPacingConfig();
  if (!acquireLock()) {
    console.log("[paced-executor] another scheduler holds the lock");
    return false;
  }

  const store = new Store(DB_PATH);
  const metaStore = new SchedulerMetaStore(DB_PATH);
  try {
    const nowMs = Date.now();
    recoverStaleRunning(store, nowMs, config.executor);
    if (store.listTasks(["running"]).length > 0) {
      console.log("[paced-executor] hold: a task is already running");
      return false;
    }

    const latest = readQuotaSnapshot(nowMs);
    if (latest.generatedAtMs === null ||
        !isLatestFresh(latest.generatedAtMs, nowMs, config.pollIntervalSeconds)) {
      console.log("[paced-executor] hold: latest quota snapshot missing or stale");
      return false;
    }
    const hard = windowGuard(latest.guard, config.executor);
    if (!hard.ok) {
      console.log(`[paced-executor] hard guard: ${hard.reason}`);
      return false;
    }

    const pacing = quotaPacingVerdict({
      enabled: pacingCfg.enabled,
      nowMs,
      sessionPct: latest.guard.sessionPct,
      sessionResetMs: latest.guard.sessionResetMs,
      weeklyPct: latest.guard.weeklyPct,
      weeklyResetMs: latest.guard.weeklyResetMs,
      sessionBudgetPct: config.executor.sessionGuardPct,
      weeklyBudgetPct: config.executor.weeklyGuardPct,
      slackPct: pacingCfg.slackPct,
      sessionWindowMs: pacingCfg.sessionWindowHours * 60 * 60 * 1000,
      weeklyWindowMs: pacingCfg.weeklyWindowHours * 60 * 60 * 1000,
    });

    const insideNight = inNightWindow(nowMs, config.nightWindow);
    const nightConfirmed = nightWindowConfirmed(config.nightWindow, currentTimezone());
    const records = store.estimationRecords();

    const candidates = store.listTasks(["queued", "carried_over"])
      .filter((task) => task.unattendedOk)
      .map((task) => ({ task, meta: metaStore.getOrDefault(task.id) }))
      .filter(({ task, meta }) => {
        if (meta.paused || meta.intent === "interactive") return false;
        if (pacingCfg.continuousEnabled && continuousEligible(task, meta)) return true;
        if (!insideNight || !nightConfirmed.ok) return false;
        const timeout = config.executor.taskTimeoutMinutes[task.size] ?? 60;
        return taskFitsNight(task, nowMs, config.nightWindow.end, timeout);
      })
      .sort(compareScheduledTasks);

    for (const { task, meta } of candidates) {
      const estimate = estimateTaskTokens({
        size: task.size,
        overrideTokens: meta.estimatedTokens,
        records,
        minSamples: pacingCfg.adaptiveMinSamples,
      });
      const staticEstimate = SIZE_ESTIMATES[task.size];
      const estimatedMinutes = Math.max(
        1,
        staticEstimate.minutes * (estimate.tokens / staticEstimate.tokens),
      );
      const admission = admitTask({
        nowMs, task, meta, pacing,
        estimatedMinutes,
        deadlineSafetyMinutes: pacingCfg.deadlineSafetyMinutes,
      });
      if (!admission.ok) {
        console.log(`[paced-executor] hold task #${task.id}: ${admission.reason}`);
        continue;
      }

      const claimed = store.claimTaskById(nowMs, task.id);
      if (!claimed) continue;
      console.log(
        `[paced-executor] task #${task.id} ${meta.intent}; ${admission.reason}; ` +
        `estimate=${Math.round(estimate.tokens / 1000)}K (${estimate.source})`,
      );
      return await executeTask(store, claimed, config, latest.guard);
    }

    if (candidates.length === 0) {
      console.log("[paced-executor] no eligible unattended tasks");
    } else if (!pacing.ok) {
      console.log(`[paced-executor] all eligible tasks held by pacing: ${pacing.reason}`);
    }
    return false;
  } finally {
    metaStore.close();
    store.close();
    releaseLock();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runPacedOnce().catch((e) => {
    console.error("[paced-executor] fatal:", e);
    process.exitCode = 1;
  });
}
