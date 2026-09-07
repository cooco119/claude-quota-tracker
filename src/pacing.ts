export interface PacingWindowInput {
  name: "session" | "weekly";
  nowMs: number;
  currentPct: number | null;
  resetEpochMs: number | null;
  windowDurationMs: number;
  budgetPct: number;
  slackPct: number;
}

export interface PacingWindowStatus {
  name: "session" | "weekly";
  currentPct: number;
  targetPct: number;
  allowedPct: number;
  elapsedFraction: number;
  aheadByPct: number;
}

export type PacingVerdict =
  | { ok: true; windows: PacingWindowStatus[] }
  | { ok: false; reason: string; windows: PacingWindowStatus[] };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute the ideal linear consumption curve for one quota window.
 *
 * `budgetPct` is normally the existing hard guard (for example 80 for the
 * 5-hour session window). The scheduler aims to reach that budget only at the
 * reset boundary, while `slackPct` permits short bursts above the ideal curve.
 */
export function pacingWindowStatus(input: PacingWindowInput):
  | { ok: true; status: PacingWindowStatus }
  | { ok: false; reason: string } {
  const {
    name, nowMs, currentPct, resetEpochMs, windowDurationMs, budgetPct, slackPct,
  } = input;

  if (currentPct === null || resetEpochMs === null) {
    return { ok: false, reason: `${name} pacing data missing` };
  }
  if (!Number.isFinite(currentPct) || currentPct < 0) {
    return { ok: false, reason: `${name} usage is invalid` };
  }
  if (!Number.isFinite(windowDurationMs) || windowDurationMs <= 0) {
    return { ok: false, reason: `${name} window duration is invalid` };
  }
  if (!Number.isFinite(budgetPct) || budgetPct <= 0 || budgetPct > 100) {
    return { ok: false, reason: `${name} pacing budget is invalid` };
  }
  if (!Number.isFinite(slackPct) || slackPct < 0) {
    return { ok: false, reason: `${name} pacing slack is invalid` };
  }
  if (resetEpochMs <= nowMs) {
    return { ok: false, reason: `${name} reset timestamp is stale` };
  }

  const startMs = resetEpochMs - windowDurationMs;
  const elapsedFraction = clamp01((nowMs - startMs) / windowDurationMs);
  const targetPct = budgetPct * elapsedFraction;
  const allowedPct = Math.min(budgetPct, targetPct + slackPct);

  return {
    ok: true,
    status: {
      name,
      currentPct,
      targetPct,
      allowedPct,
      elapsedFraction,
      aheadByPct: currentPct - targetPct,
    },
  };
}

/**
 * Admission control for queued background work. Both windows must have spare
 * paced capacity; whichever is furthest ahead of its allowed curve becomes the
 * bottleneck. Hard exhaustion guards remain a separate, authoritative layer.
 */
export function quotaPacingVerdict(args: {
  enabled: boolean;
  nowMs: number;
  sessionPct: number | null;
  sessionResetMs: number | null;
  weeklyPct: number | null;
  weeklyResetMs: number | null;
  sessionBudgetPct: number;
  weeklyBudgetPct: number;
  slackPct: number;
  sessionWindowMs: number;
  weeklyWindowMs: number;
}): PacingVerdict {
  if (!args.enabled) return { ok: true, windows: [] };

  const results = [
    pacingWindowStatus({
      name: "session",
      nowMs: args.nowMs,
      currentPct: args.sessionPct,
      resetEpochMs: args.sessionResetMs,
      windowDurationMs: args.sessionWindowMs,
      budgetPct: args.sessionBudgetPct,
      slackPct: args.slackPct,
    }),
    pacingWindowStatus({
      name: "weekly",
      nowMs: args.nowMs,
      currentPct: args.weeklyPct,
      resetEpochMs: args.weeklyResetMs,
      windowDurationMs: args.weeklyWindowMs,
      budgetPct: args.weeklyBudgetPct,
      slackPct: args.slackPct,
    }),
  ];

  for (const result of results) {
    if (!result.ok) return { ok: false, reason: result.reason, windows: [] };
  }

  const windows = results.map((r) => {
    if (!r.ok) throw new Error("unreachable pacing result");
    return r.status;
  });
  const blocked = windows
    .filter((w) => w.currentPct > w.allowedPct)
    .sort(
      (a, b) =>
        (b.currentPct - b.allowedPct) - (a.currentPct - a.allowedPct),
    )[0];

  if (blocked) {
    return {
      ok: false,
      reason:
        `${blocked.name} pacing: ${blocked.currentPct.toFixed(1)}% used > ` +
        `${blocked.allowedPct.toFixed(1)}% allowed ` +
        `(target ${blocked.targetPct.toFixed(1)}%); wait for budget to catch up`,
      windows,
    };
  }

  return { ok: true, windows };
}
