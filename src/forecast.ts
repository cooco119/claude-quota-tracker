import type { HistoryPoint } from "./store.js";

export interface Forecast {
  /** Predicted usage percent at the window's reset time (clamped to >= current). */
  predictedPctAtReset: number;
  /** Estimated burn rate in percent per hour. */
  burnRatePctPerHour: number;
  /** "history" = regression over recent points, "window-linear" = fallback. */
  method: "history" | "window-linear";
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Minimum time span of in-window history before the regression slope is
 * trusted. Percentages are integer-quantized, so two polls minutes apart can
 * fabricate an absurd slope (observed: 13%->14% in 1 min => 60%/h).
 */
const MIN_HISTORY_SPAN_MS = 30 * 60 * 1000;

/** Least-squares slope (pct per ms) over history points. */
function slope(points: HistoryPoint[]): number {
  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.ts, 0) / n;
  const meanP = points.reduce((s, p) => s + p.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.ts - meanT) * (p.pct - meanP);
    den += (p.ts - meanT) * (p.ts - meanT);
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Predict usage at reset: U + r * T.
 *
 * r comes from recent history within the current window (points after the
 * last observed reset boundary, i.e. where pct did not drop). With fewer than
 * 2 usable points, falls back to a linear rate from the window's start
 * (reset - windowDuration) to now.
 */
export function forecastAtReset(args: {
  nowMs: number;
  currentPct: number;
  resetEpochMs: number;
  windowDurationMs: number;
  history: HistoryPoint[];
}): Forecast {
  const { nowMs, currentPct, resetEpochMs, windowDurationMs, history } = args;
  const remainingMs = Math.max(0, resetEpochMs - nowMs);

  // Use only points from the current window: walk back from the end while
  // pct is non-increasing going backwards (a drop going forward = a reset).
  const recent: HistoryPoint[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i];
    if (recent.length > 0 && p.pct > recent[0].pct) break;
    recent.unshift(p);
  }

  let ratePerMs: number;
  let method: Forecast["method"];
  if (
    recent.length >= 2 &&
    recent[recent.length - 1].ts - recent[0].ts >= MIN_HISTORY_SPAN_MS
  ) {
    ratePerMs = Math.max(0, slope(recent));
    method = "history";
  } else {
    const windowStartMs = resetEpochMs - windowDurationMs;
    const elapsedMs = nowMs - windowStartMs;
    ratePerMs = elapsedMs > 0 ? currentPct / elapsedMs : 0;
    method = "window-linear";
  }

  const predicted = Math.max(currentPct, currentPct + ratePerMs * remainingMs);
  return {
    predictedPctAtReset: predicted,
    burnRatePctPerHour: ratePerMs * HOUR_MS,
    method,
  };
}

/**
 * When the predicted usage exceeds 100%, the window is on pace to be exhausted
 * before reset. Returns the epoch ms at which it hits 100% (capped meaning is
 * more useful than a >100% number), or null if it won't fill before reset.
 */
export function exhaustionEpochMs(args: {
  nowMs: number;
  currentPct: number;
  burnRatePctPerHour: number;
  resetEpochMs: number;
}): number | null {
  const { nowMs, currentPct, burnRatePctPerHour, resetEpochMs } = args;
  if (burnRatePctPerHour <= 0 || currentPct >= 100) {
    return currentPct >= 100 ? nowMs : null;
  }
  const eta = nowMs + ((100 - currentPct) / burnRatePctPerHour) * HOUR_MS;
  return eta <= resetEpochMs ? eta : null;
}
