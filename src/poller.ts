import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DATA_DIR, DB_PATH, LATEST_JSON_PATH, NOTIFY_STATE_PATH, loadConfig,
  type Config,
} from "./config.js";
import { recoverStaleRunning } from "./executor.js";
import { ingestUsage } from "./ingest.js";
import { isSea } from "./sea.js";
import { currentTimezone, shouldRunExecutor } from "./tasks.js";
import { forecastAtReset, type Forecast } from "./forecast.js";
import {
  decideNudges, loadNotifyState, markSent, saveNotifyState,
  sendMacNotification, type NudgeInput,
} from "./notify.js";
import { allProviders } from "./providers/index.js";
import { Store } from "./store.js";
import { WINDOW_DURATION_MS, type WindowReading } from "./types.js";

interface LatestWindow extends WindowReading {
  forecast: Forecast | null;
}

interface LatestJson {
  generatedAtMs: number;
  providers: Record<string, { windows: LatestWindow[] }>;
}

export async function pollOnce(nowMs: number = Date.now()): Promise<LatestJson> {
  const config = loadConfig();
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new Store(DB_PATH);
  const latest: LatestJson = { generatedAtMs: nowMs, providers: {} };
  let anySuccess = false;

  try {
    for (const provider of allProviders()) {
      let readings: WindowReading[];
      try {
        readings = await provider.fetch();
      } catch (e) {
        console.error(`[quota-tracker] ${provider.id} fetch failed:`, e);
        continue;
      }
      anySuccess = true;
      store.appendSnapshot(nowMs, provider.id, readings);

      const windows: LatestWindow[] = [];
      const nudgeInputs: NudgeInput[] = [];
      for (const r of readings) {
        let forecast: Forecast | null = null;
        if (r.pct !== null && r.resetEpochMs !== null) {
          const windowDurationMs = WINDOW_DURATION_MS[r.windowKey];
          const history = store.history(
            provider.id, r.windowKey, nowMs - windowDurationMs,
          );
          forecast = forecastAtReset({
            nowMs,
            currentPct: r.pct,
            resetEpochMs: r.resetEpochMs,
            windowDurationMs,
            history,
          });
          nudgeInputs.push({
            windowKey: r.windowKey,
            pct: r.pct,
            resetEpochMs: r.resetEpochMs,
            windowDurationMs,
            forecast,
          });
        }
        windows.push({ ...r, forecast });
      }
      latest.providers[provider.id] = { windows };

      const state = loadNotifyState(NOTIFY_STATE_PATH);
      const nudges = decideNudges({
        nowMs, items: nudgeInputs, config: config.notify, state,
      });
      for (const nudge of nudges) await sendMacNotification(nudge);
      if (nudges.length > 0) {
        saveNotifyState(NOTIFY_STATE_PATH, markSent(state, nudges, nowMs));
      }
    }
  } finally {
    store.close();
  }

  // On total fetch failure keep the previous latest.json so the menubar
  // shows last-good data instead of blanking for a poll cycle.
  if (anySuccess) {
    writeFileSync(LATEST_JSON_PATH, JSON.stringify(latest, null, 2));
  }

  // Part C hook, fully isolated: ingest Claude Code session logs into
  // usage_events. A failure here must never break Part A polling.
  try {
    const store = new Store(DB_PATH);
    try {
      const r = ingestUsage(store, nowMs);
      if (r.inserted > 0) {
        console.log(`[quota-tracker] ingested ${r.inserted} usage events`);
      }
    } finally {
      store.close();
    }
  } catch (e) {
    console.error("[quota-tracker] usage ingest hook failed:", e);
  }

  // Part B hook, fully isolated: a failure here must never break Part A polling.
  try {
    maybeSpawnExecutor(latest, config);
  } catch (e) {
    console.error("[quota-tracker] executor spawn hook failed:", e);
  }

  return latest;
}

/**
 * Spawn the night executor as a detached one-shot when every gate passes.
 * Detached so a long task never blocks the next 5-minute poll tick.
 */
function maybeSpawnExecutor(latest: LatestJson, config: Config): void {
  if (!config.executor.enabled) return;
  const nowMs = Date.now();
  const windows = latest.providers["claude"]?.windows ?? [];
  const find = (key: string) => windows.find((w) => w.windowKey === key);

  const store = new Store(DB_PATH);
  let verdict: ReturnType<typeof shouldRunExecutor>;
  try {
    recoverStaleRunning(store, nowMs, config.executor);
    verdict = shouldRunExecutor({
      nowMs,
      config,
      currentTz: currentTimezone(),
      latestGeneratedAtMs: latest.generatedAtMs,
      guard: {
        nowMs,
        sessionPct: find("session_5h")?.pct ?? null,
        sessionResetMs: find("session_5h")?.resetEpochMs ?? null,
        weeklyPct: find("weekly_all")?.pct ?? null,
        weeklyResetMs: find("weekly_all")?.resetEpochMs ?? null,
      },
      hasClaimableTask: store.hasClaimableTask(),
      hasLiveRunningTask: store.listTasks(["running"]).length > 0,
    });
  } finally {
    store.close();
  }
  if (!verdict.ok) {
    // A timezone change silently freezes night dispatch — nudge once per 12h.
    if (verdict.reason.includes("timezone changed")) {
      const state = loadNotifyState(NOTIFY_STATE_PATH);
      const last = state["nightWindow:reconfirm"] ?? 0;
      if (nowMs - last > 12 * 60 * 60 * 1000) {
        void sendMacNotification({
          mode: "scheduleHint", windowKey: "session_5h",
          title: "quota-tracker: night window 재컨펌 필요",
          message: `${verdict.reason} — npm run enqueue로 재컨펌하세요.`,
        });
        state["nightWindow:reconfirm"] = nowMs;
        saveNotifyState(NOTIFY_STATE_PATH, state);
      }
    }
    return;
  }

  // Baked binary: re-invoke ourselves with the subcommand. Dev: node dist/executor.js.
  const executorArgs = isSea()
    ? ["executor"]
    : [join(dirname(fileURLToPath(import.meta.url)), "executor.js")];
  const log = openSync(join(DATA_DIR, "executor.log"), "a");
  const child = spawn(process.execPath, executorArgs, {
    detached: true,
    stdio: ["ignore", log, log],
  });
  // The async 'error' event escapes the synchronous try/catch around this hook.
  child.on("error", (e) => console.error("[quota-tracker] executor spawn failed:", e));
  child.unref();
  console.log(`[quota-tracker] spawned night executor (pid ${child.pid})`);
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  pollOnce()
    .then((latest) => {
      const n = Object.values(latest.providers)
        .reduce((s, p) => s + p.windows.length, 0);
      console.log(`[quota-tracker] polled ${n} window readings`);
    })
    .catch((e) => {
      console.error("[quota-tracker] poll failed:", e);
      process.exitCode = 1;
    });
}
