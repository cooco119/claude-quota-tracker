import { describe, expect, it } from "vitest";
import type { NotifyConfig } from "../src/config.js";
import { forecastAtReset } from "../src/forecast.js";
import { decideNudges, isQuietHours, markSent, type NudgeInput } from "../src/notify.js";
import type { HistoryPoint } from "../src/store.js";

const H = 60 * 60 * 1000;
const FIVE_H = 5 * H;
const NOW = Date.UTC(2026, 5, 11, 5, 0); // 14:00 KST — outside quiet hours

const CONFIG: NotifyConfig = {
  underUse: { enabled: true, thresholdPct: 80 },
  overUse: { enabled: false, thresholdPct: 100 },
  scheduleHint: { enabled: false },
  cooldownMinutes: 120,
  quietHours: null,
  minElapsedFraction: 0.25,
};

/** Build a NudgeInput from synthetic history, running the real forecast. */
function inputFromHistory(history: HistoryPoint[], resetMs: number): NudgeInput {
  const currentPct = history[history.length - 1].pct;
  return {
    windowKey: "session_5h",
    pct: currentPct,
    resetEpochMs: resetMs,
    windowDurationMs: FIVE_H,
    forecast: forecastAtReset({
      nowMs: NOW, currentPct, resetEpochMs: resetMs,
      windowDurationMs: FIVE_H, history,
    }),
  };
}

function slowHistory(): HistoryPoint[] {
  // 2h elapsed, crawling at ~2%/h -> 4% now, ~10% at reset: under-used
  return [0, 1, 2, 3, 4].map((i) => ({
    ts: NOW - 2 * H + i * 30 * 60 * 1000, pct: i, resetEpochMs: null,
  }));
}

function fastHistory(): HistoryPoint[] {
  // 2h elapsed, burning 20%/h -> 40% now, ~100% at reset: well-used
  return [0, 10, 20, 30, 40].map((pct, i) => ({
    ts: NOW - 2 * H + i * 30 * 60 * 1000, pct, resetEpochMs: null,
  }));
}

describe("decideNudges — under-use", () => {
  it("fires when synthetic history predicts the window won't be filled", () => {
    const item = inputFromHistory(slowHistory(), NOW + 3 * H);
    const nudges = decideNudges({ nowMs: NOW, items: [item], config: CONFIG, state: {} });
    expect(nudges).toHaveLength(1);
    expect(nudges[0].mode).toBe("underUse");
    expect(nudges[0].message).toContain("Spare capacity");
  });

  it("does not fire when burn rate is on pace to fill the window", () => {
    const item = inputFromHistory(fastHistory(), NOW + 3 * H);
    const nudges = decideNudges({ nowMs: NOW, items: [item], config: CONFIG, state: {} });
    expect(nudges).toHaveLength(0);
  });

  it("does not fire early in the window (minElapsedFraction)", () => {
    // Only 30min of a 5h window elapsed
    const item = inputFromHistory(slowHistory(), NOW + 4.5 * H);
    const nudges = decideNudges({ nowMs: NOW, items: [item], config: CONFIG, state: {} });
    expect(nudges).toHaveLength(0);
  });

  it("respects cooldown after firing, then fires again once expired", () => {
    const item = inputFromHistory(slowHistory(), NOW + 3 * H);
    const first = decideNudges({ nowMs: NOW, items: [item], config: CONFIG, state: {} });
    expect(first).toHaveLength(1);
    const state = markSent({}, first, NOW);
    const during = decideNudges({
      nowMs: NOW + H, items: [item], config: CONFIG, state,
    });
    expect(during).toHaveLength(0); // 1h later, 2h cooldown still active
    const after = decideNudges({
      nowMs: NOW + 2.5 * H, items: [item], config: CONFIG, state,
    });
    expect(after).toHaveLength(1); // cooldown expired, 1.5h still left in window
    expect(after[0].mode).toBe("underUse");
  });

  it("does not fire when mode is disabled", () => {
    const item = inputFromHistory(slowHistory(), NOW + 3 * H);
    const config = { ...CONFIG, underUse: { enabled: false, thresholdPct: 80 } };
    expect(decideNudges({ nowMs: NOW, items: [item], config, state: {} })).toHaveLength(0);
  });

  it("does not fire during quiet hours", () => {
    const item = inputFromHistory(slowHistory(), NOW + 3 * H);
    const config = { ...CONFIG, quietHours: { start: "00:00", end: "23:59" } };
    expect(decideNudges({ nowMs: NOW, items: [item], config, state: {} })).toHaveLength(0);
  });
});

describe("decideNudges — over-use (off by default)", () => {
  it("fires only when enabled and pace exceeds threshold", () => {
    const item = inputFromHistory(fastHistory(), NOW + 4 * H); // ~120% pace
    expect(decideNudges({ nowMs: NOW, items: [item], config: CONFIG, state: {} }))
      .toHaveLength(0);
    const enabled = { ...CONFIG, overUse: { enabled: true, thresholdPct: 100 } };
    const nudges = decideNudges({ nowMs: NOW, items: [item], config: enabled, state: {} });
    expect(nudges).toHaveLength(1);
    expect(nudges[0].mode).toBe("overUse");
  });
});

describe("isQuietHours", () => {
  it("handles ranges crossing midnight", () => {
    const quiet = { start: "23:00", end: "08:00" };
    const at = (h: number, m = 0) => {
      const d = new Date(2026, 5, 11, h, m); // local time
      return d.getTime();
    };
    expect(isQuietHours(at(23, 30), quiet)).toBe(true);
    expect(isQuietHours(at(2), quiet)).toBe(true);
    expect(isQuietHours(at(7, 59), quiet)).toBe(true);
    expect(isQuietHours(at(8), quiet)).toBe(false);
    expect(isQuietHours(at(14), quiet)).toBe(false);
    expect(isQuietHours(at(14), null)).toBe(false);
  });
});
