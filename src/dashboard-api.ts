import { existsSync, readFileSync } from "node:fs";
import { LATEST_JSON_PATH } from "./config.js";
import { exhaustionEpochMs, type Forecast } from "./forecast.js";
import { Store } from "./store.js";
import {
  SIZE_ESTIMATES, WINDOW_DURATION_MS, type TaskSize, type WindowKey,
} from "./types.js";

const WINDOW_LABEL: Record<WindowKey, string> = {
  session_5h: "Session (5h)",
  weekly_all: "Week (all models)",
  weekly_sonnet: "Week (Sonnet)",
};

const DAY_MS = 24 * 60 * 60 * 1000;

interface LatestWindow {
  windowKey: WindowKey;
  pct: number | null;
  resetEpochMs: number | null;
  forecast: Forecast | null;
}

interface LatestJson {
  generatedAtMs: number;
  providers: Record<string, { windows: LatestWindow[] }>;
}

function readLatest(): LatestJson | null {
  if (!existsSync(LATEST_JSON_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LATEST_JSON_PATH, "utf8")) as LatestJson;
  } catch {
    return null;
  }
}

/** Tier 1 hero: window gauges + forecast + 7-day KPI. */
export function overview(store: Store, nowMs: number) {
  const latest = readLatest();
  const windows = (latest?.providers["claude"]?.windows ?? []).map((w) => ({
    key: w.windowKey,
    label: WINDOW_LABEL[w.windowKey] ?? w.windowKey,
    pct: w.pct,
    resetEpochMs: w.resetEpochMs,
    forecast: w.forecast,
    exhaustionEpochMs:
      w.forecast && w.pct !== null && w.resetEpochMs !== null
        ? exhaustionEpochMs({
            nowMs,
            currentPct: w.pct,
            burnRatePctPerHour: w.forecast.burnRatePctPerHour,
            resetEpochMs: w.resetEpochMs,
          })
        : null,
  }));
  const k = store.runCostSummary(nowMs - 7 * DAY_MS, nowMs);
  return {
    generatedAtMs: latest?.generatedAtMs ?? null,
    ageMin: latest ? Math.round((nowMs - latest.generatedAtMs) / 60000) : null,
    windows,
    kpi: { cost7d: k.totalCostUsd, tokens7d: k.totalTokens, runs7d: k.runs },
    // Honest scope label: these runs are quota-tracker's own orchestrated tasks.
    scopeNote: "task_runs = quota-tracker가 실행한 태스크 (전체 Claude 사용량 아님)",
  };
}

/** Tier 2: per-model usage + token-category split. */
export function models(store: Store, fromTs: number, toTs: number) {
  return {
    from: fromTs,
    to: toTs,
    totals: store.modelTotals(fromTs, toTs),
    categories: store.tokenCategoryTotals(fromTs, toTs),
  };
}

/** Tier 2: GitHub-style contribution — local-day buckets, gaps filled with 0. */
export function contrib(
  store: Store, fromTs: number, toTs: number, metric: "tokens" | "cost",
) {
  const runs = store.runsInRange(fromTs, toTs);
  const byDay = new Map<number, { value: number; runs: number }>();
  const dayKey = (ts: number): number => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0); // local midnight
    return d.getTime();
  };
  for (const r of runs) {
    const key = dayKey(r.startedTs);
    const cur = byDay.get(key) ?? { value: 0, runs: 0 };
    cur.value += metric === "cost" ? r.costUsd : r.totalTokens;
    cur.runs += 1;
    byDay.set(key, cur);
  }
  // Fill every local day in range so the heatmap grid is continuous. Step by
  // calendar day (setDate), not += DAY_MS — fixed-ms steps drift across DST
  // days (23/25h) and miss/duplicate buckets. Cap the grid so a huge or
  // malformed range can't blow up memory.
  const MAX_DAYS = 370;
  const days: Array<{ day: number; value: number; runs: number }> = [];
  const cur = new Date(fromTs);
  cur.setHours(0, 0, 0, 0);
  for (let i = 0; i < MAX_DAYS && cur.getTime() <= toTs; i++) {
    const key = cur.getTime();
    const e = byDay.get(key);
    days.push({ day: key, value: e?.value ?? 0, runs: e?.runs ?? 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return { from: fromTs, to: toTs, metric, days };
}

/** Tier 3: per-window usage time series. */
export function timeseries(store: Store, nowMs: number) {
  const out: Record<string, Array<{ ts: number; pct: number }>> = {};
  for (const key of Object.keys(WINDOW_DURATION_MS) as WindowKey[]) {
    const dur = WINDOW_DURATION_MS[key];
    out[key] = store
      .history("claude", key, nowMs - dur)
      .map((p) => ({ ts: p.ts, pct: p.pct }));
  }
  return out;
}

/** Tier 3: estimate vs actual, plus per-size accuracy summary. */
export function estimates(store: Store) {
  const records = store.estimationRecords();
  const bySize = new Map<TaskSize, number[]>();
  for (const r of records) {
    if (r.actualTokens === null || !r.estimateTokens) continue;
    const ratio = r.actualTokens / r.estimateTokens;
    const arr = bySize.get(r.size) ?? [];
    arr.push(ratio);
    bySize.set(r.size, arr);
  }
  const summary = (Object.keys(SIZE_ESTIMATES) as TaskSize[])
    .filter((s) => bySize.has(s))
    .map((s) => {
      const ratios = bySize.get(s)!.sort((a, b) => a - b);
      const mid = Math.floor(ratios.length / 2);
      const median = ratios.length % 2
        ? ratios[mid]
        : (ratios[mid - 1] + ratios[mid]) / 2;
      return { size: s, medianRatio: median, n: ratios.length };
    });
  return { records, summary };
}

export function queue(store: Store) {
  return store.queueCounts();
}
