import { describe, expect, it } from "vitest";
import { exhaustionEpochMs, forecastAtReset } from "../src/forecast.js";
import type { HistoryPoint } from "../src/store.js";

const H = 60 * 60 * 1000;
const FIVE_H = 5 * H;

function series(startTs: number, stepMs: number, pcts: number[]): HistoryPoint[] {
  return pcts.map((pct, i) => ({ ts: startTs + i * stepMs, pct, resetEpochMs: null }));
}

describe("forecastAtReset", () => {
  it("extrapolates U + r*T from steady history", () => {
    // 10%/h burn over the last hour, 2h left -> 20 + 2*10 = 40
    const now = 1_000_000_000_000;
    const history = series(now - H, 5 * 60 * 1000, [
      10, 10.8, 11.7, 12.5, 13.3, 14.2, 15, 15.8, 16.7, 17.5, 18.3, 19.2, 20,
    ]);
    const fc = forecastAtReset({
      nowMs: now, currentPct: 20, resetEpochMs: now + 2 * H,
      windowDurationMs: FIVE_H, history,
    });
    expect(fc.method).toBe("history");
    expect(fc.burnRatePctPerHour).toBeCloseTo(10, 0);
    expect(fc.predictedPctAtReset).toBeGreaterThan(38);
    expect(fc.predictedPctAtReset).toBeLessThan(42);
  });

  it("distrusts history spanning under 30min (quantized pct noise)", () => {
    // Two polls 1 min apart, 13% -> 14%: naive slope would be 60%/h
    const now = 1_000_000_000_000;
    const history: HistoryPoint[] = [
      { ts: now - 60_000, pct: 13, resetEpochMs: null },
      { ts: now, pct: 14, resetEpochMs: null },
    ];
    const fc = forecastAtReset({
      nowMs: now, currentPct: 14, resetEpochMs: now + 3.5 * H,
      windowDurationMs: FIVE_H, history,
    });
    expect(fc.method).toBe("window-linear");
    expect(fc.predictedPctAtReset).toBeLessThan(100);
  });

  it("falls back to linear-from-window-start with no history", () => {
    // Window started 2.5h ago at 0%, now 25% -> 10%/h, 2.5h left -> 50%
    const now = 1_000_000_000_000;
    const fc = forecastAtReset({
      nowMs: now, currentPct: 25, resetEpochMs: now + 2.5 * H,
      windowDurationMs: FIVE_H, history: [],
    });
    expect(fc.method).toBe("window-linear");
    expect(fc.predictedPctAtReset).toBeCloseTo(50, 1);
    expect(fc.burnRatePctPerHour).toBeCloseTo(10, 1);
  });

  it("ignores history from before a reset (pct drop)", () => {
    const now = 1_000_000_000_000;
    // Old window climbed to 90%, then reset; current window: 5 -> 10
    const history: HistoryPoint[] = [
      ...series(now - 3 * H, 30 * 60 * 1000, [80, 85, 90]),
      ...series(now - H, 30 * 60 * 1000, [5, 7.5, 10]),
    ];
    const fc = forecastAtReset({
      nowMs: now, currentPct: 10, resetEpochMs: now + H,
      windowDurationMs: FIVE_H, history,
    });
    expect(fc.method).toBe("history");
    // 5%/h from current window only -> ~15, not dragged up by the old 90s
    expect(fc.predictedPctAtReset).toBeCloseTo(15, 0);
  });

  it("never predicts below current usage (idle history)", () => {
    const now = 1_000_000_000_000;
    const history = series(now - H, 30 * 60 * 1000, [30, 30, 30]);
    const fc = forecastAtReset({
      nowMs: now, currentPct: 30, resetEpochMs: now + 2 * H,
      windowDurationMs: FIVE_H, history,
    });
    expect(fc.predictedPctAtReset).toBe(30);
    expect(fc.burnRatePctPerHour).toBe(0);
  });

  it("returns current pct when reset already passed", () => {
    const now = 1_000_000_000_000;
    const fc = forecastAtReset({
      nowMs: now, currentPct: 60, resetEpochMs: now - 1000,
      windowDurationMs: FIVE_H, history: [],
    });
    expect(fc.predictedPctAtReset).toBe(60);
  });
});

describe("exhaustionEpochMs", () => {
  const now = 1_000_000_000_000;

  it("returns the time the window hits 100% when on pace to exhaust", () => {
    // 20% now, 40%/h, reset in 3h -> hits 100% in (80/40)=2h, before reset
    const eta = exhaustionEpochMs({
      nowMs: now, currentPct: 20, burnRatePctPerHour: 40, resetEpochMs: now + 3 * H,
    });
    expect(eta).toBe(now + 2 * H);
  });

  it("returns null when it won't fill before reset", () => {
    const eta = exhaustionEpochMs({
      nowMs: now, currentPct: 20, burnRatePctPerHour: 10, resetEpochMs: now + 3 * H,
    });
    expect(eta).toBeNull(); // would need 8h, only 3h left
  });

  it("returns null at zero burn rate", () => {
    expect(exhaustionEpochMs({
      nowMs: now, currentPct: 50, burnRatePctPerHour: 0, resetEpochMs: now + 3 * H,
    })).toBeNull();
  });

  it("returns now when already at/over 100%", () => {
    expect(exhaustionEpochMs({
      nowMs: now, currentPct: 100, burnRatePctPerHour: 5, resetEpochMs: now + 3 * H,
    })).toBe(now);
  });
});
