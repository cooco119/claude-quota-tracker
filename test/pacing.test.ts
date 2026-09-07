import { describe, expect, it } from "vitest";
import { pacingWindowStatus, quotaPacingVerdict } from "../src/pacing.js";

const H = 60 * 60 * 1000;
const DAY = 24 * H;
const now = new Date("2026-09-07T12:00:00.000Z").getTime();

describe("pacingWindowStatus", () => {
  it("computes a linear target from elapsed window fraction", () => {
    const r = pacingWindowStatus({
      name: "session",
      nowMs: now,
      currentPct: 30,
      resetEpochMs: now + 2.5 * H,
      windowDurationMs: 5 * H,
      budgetPct: 80,
      slackPct: 5,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status.elapsedFraction).toBeCloseTo(0.5);
      expect(r.status.targetPct).toBeCloseTo(40);
      expect(r.status.allowedPct).toBeCloseTo(45);
    }
  });

  it("fails closed on missing usage data", () => {
    expect(pacingWindowStatus({
      name: "weekly",
      nowMs: now,
      currentPct: null,
      resetEpochMs: now + DAY,
      windowDurationMs: 7 * DAY,
      budgetPct: 95,
      slackPct: 5,
    }).ok).toBe(false);
  });
});

describe("quotaPacingVerdict", () => {
  const base = {
    enabled: true,
    nowMs: now,
    sessionPct: 30,
    sessionResetMs: now + 2.5 * H,
    weeklyPct: 40,
    weeklyResetMs: now + 3.5 * DAY,
    sessionBudgetPct: 80,
    weeklyBudgetPct: 95,
    slackPct: 5,
    sessionWindowMs: 5 * H,
    weeklyWindowMs: 7 * DAY,
  };

  it("allows work when both windows are behind their paced allowance", () => {
    expect(quotaPacingVerdict(base).ok).toBe(true);
  });

  it("blocks when the session window is ahead of its curve", () => {
    const v = quotaPacingVerdict({ ...base, sessionPct: 60 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("session pacing");
  });

  it("blocks when the weekly window is the bottleneck", () => {
    const v = quotaPacingVerdict({ ...base, weeklyPct: 70 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("weekly pacing");
  });

  it("uses slack to permit short bursts", () => {
    expect(quotaPacingVerdict({ ...base, sessionPct: 44 }).ok).toBe(true);
    expect(quotaPacingVerdict({ ...base, sessionPct: 46 }).ok).toBe(false);
  });

  it("is a no-op when disabled for backwards compatibility", () => {
    expect(quotaPacingVerdict({
      ...base,
      enabled: false,
      sessionPct: null,
      weeklyPct: null,
    })).toEqual({ ok: true, windows: [] });
  });

  it("fails closed on stale reset metadata", () => {
    expect(quotaPacingVerdict({ ...base, sessionResetMs: now - 1 }).ok).toBe(false);
  });
});
