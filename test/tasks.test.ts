import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config, type NightWindow } from "../src/config.js";
import {
  activeNightStartMs, bestNightStartMs, confirmPhrase, inNightWindow,
  isLatestFresh, msUntilWindowEnd, nightWindowConfirmed, nightWindowHours,
  parseHHMMRange, shouldRunExecutor, windowGuard, type GuardInput,
} from "../src/tasks.js";
import type { HistoryPoint } from "../src/store.js";

const H = 60 * 60 * 1000;

const CONFIRMED_NW: NightWindow = {
  start: "23:00", end: "08:00",
  confirmedAt: "2026-06-11T12:00:00.000Z", confirmedTz: "Asia/Seoul",
};

function configWith(nw: Partial<NightWindow>): Config {
  return {
    ...DEFAULT_CONFIG,
    nightWindow: { ...CONFIRMED_NW, ...nw },
  };
}

/** Local wall-clock helper. */
const at = (h: number, m = 0) => new Date(2026, 5, 11, h, m).getTime();

const OK_GUARD: GuardInput = {
  nowMs: at(2), sessionPct: 20, sessionResetMs: at(2) + 3 * H,
  weeklyPct: 50, weeklyResetMs: at(2) + 48 * H,
};

function gateInput(overrides: Partial<Parameters<typeof shouldRunExecutor>[0]>) {
  return {
    nowMs: at(2), // 02:00 — inside 23:00-08:00
    config: configWith({}),
    currentTz: "Asia/Seoul",
    latestGeneratedAtMs: at(2) - 60_000,
    guard: OK_GUARD,
    hasClaimableTask: true,
    hasLiveRunningTask: false,
    ...overrides,
  };
}

describe("night window", () => {
  it("handles ranges crossing midnight", () => {
    const nw = { start: "23:00", end: "08:00" };
    expect(inNightWindow(at(1, 30), nw)).toBe(true);
    expect(inNightWindow(at(23, 0), nw)).toBe(true);
    expect(inNightWindow(at(12, 0), nw)).toBe(false);
    expect(inNightWindow(at(8, 0), nw)).toBe(false);
  });

  it("refuses dispatch until confirmed (gate 2)", () => {
    const v = nightWindowConfirmed({ ...CONFIRMED_NW, confirmedAt: null }, "Asia/Seoul");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not confirmed");
  });

  it("requires re-confirmation when timezone changed", () => {
    const v = nightWindowConfirmed(CONFIRMED_NW, "America/Los_Angeles");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("timezone changed");
    expect(nightWindowConfirmed(CONFIRMED_NW, "Asia/Seoul").ok).toBe(true);
  });
});

describe("window guard (asymmetric, gate 3)", () => {
  const cfg = DEFAULT_CONFIG.executor; // session 80, weekly 95

  it("pauses when session window is at/above the session guard", () => {
    const v = windowGuard({ ...OK_GUARD, sessionPct: 85 }, cfg);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("session");
  });

  it("pauses only near weekly exhaustion (fill-target leniency)", () => {
    expect(windowGuard({ ...OK_GUARD, sessionPct: 50, weeklyPct: 96 }, cfg).ok).toBe(false);
    expect(windowGuard({ ...OK_GUARD, sessionPct: 50, weeklyPct: 90 }, cfg).ok).toBe(true);
  });

  it("blocks when usage data is missing", () => {
    expect(windowGuard({ ...OK_GUARD, sessionPct: null }, cfg).ok).toBe(false);
  });
});

describe("latest.json freshness", () => {
  it("accepts within 2x poll interval, rejects older", () => {
    const now = at(2);
    expect(isLatestFresh(now - 9 * 60 * 1000, now, 300)).toBe(true);
    expect(isLatestFresh(now - 11 * 60 * 1000, now, 300)).toBe(false);
  });
});

describe("shouldRunExecutor gate chain", () => {
  it("passes when everything is in order", () => {
    expect(shouldRunExecutor(gateInput({}))).toEqual({ ok: true });
  });

  it.each([
    ["disabled", gateInput({ config: { ...configWith({}), executor: { ...DEFAULT_CONFIG.executor, enabled: false } } }), "disabled"],
    ["daytime", gateInput({ nowMs: at(14) }), "outside night window"],
    ["unconfirmed", gateInput({ config: configWith({ confirmedAt: null }) }), "not confirmed"],
    ["tz changed", gateInput({ currentTz: "America/Los_Angeles" }), "timezone changed"],
    ["stale latest", gateInput({ latestGeneratedAtMs: at(2) - 30 * 60 * 1000 }), "stale"],
    ["missing latest", gateInput({ latestGeneratedAtMs: null }), "stale"],
    ["guard", gateInput({ guard: { ...OK_GUARD, sessionPct: 90 } }), "session"],
    ["empty queue", gateInput({ hasClaimableTask: false }), "no claimable"],
    ["already running", gateInput({ hasLiveRunningTask: true }), "already running"],
  ])("refuses on %s", (_name, input, reasonPart) => {
    const v = shouldRunExecutor(input);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(reasonPart);
  });
});

describe("parseHHMMRange", () => {
  it("parses valid ranges and zero-pads", () => {
    expect(parseHHMMRange("0:30-7:00")).toEqual({ start: "00:30", end: "07:00" });
    expect(parseHHMMRange("23:00 - 08:00")).toEqual({ start: "23:00", end: "08:00" });
  });

  it("rejects out-of-range times and garbage", () => {
    expect(parseHHMMRange("24:00-08:00")).toBeNull();
    expect(parseHHMMRange("23:60-08:00")).toBeNull();
    expect(parseHHMMRange("night")).toBeNull();
    expect(parseHHMMRange("")).toBeNull();
  });
});

describe("msUntilWindowEnd", () => {
  const nw = { end: "08:00" };
  it("measures to today's end when before it", () => {
    expect(msUntilWindowEnd(at(2, 0), nw)).toBe(6 * H);
  });
  it("measures to tomorrow's end when past it (window crossing midnight)", () => {
    expect(msUntilWindowEnd(at(23, 30), nw)).toBe(8.5 * H);
  });
});

describe("nightWindowHours", () => {
  it("lists hours of a midnight-crossing window", () => {
    expect(nightWindowHours({ start: "23:00", end: "08:00" }))
      .toEqual([23, 0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("lists hours of a same-day window", () => {
    expect(nightWindowHours({ start: "01:00", end: "04:00" })).toEqual([1, 2, 3]);
  });
});

describe("activeNightStartMs", () => {
  it("uses today's start when now is past it", () => {
    const now = new Date(2026, 5, 12, 2, 0).getTime(); // 02:00, window starts 23:00
    expect(activeNightStartMs(now, "23:00")).toBe(new Date(2026, 5, 11, 23, 0).getTime());
  });
  it("uses today's start when now is after it the same evening", () => {
    const now = new Date(2026, 5, 12, 23, 30).getTime();
    expect(activeNightStartMs(now, "23:00")).toBe(new Date(2026, 5, 12, 23, 0).getTime());
  });
});

describe("bestNightStartMs", () => {
  const nw = { start: "23:00", end: "08:00" };
  const now = new Date(2026, 5, 12, 23, 30).getTime(); // inside window

  it("falls back to window start when history is below minDays", () => {
    const r = bestNightStartMs({ nowMs: now, nightWindow: nw, history: [], minDays: 3 });
    expect(r.reason).toBe("window-start");
    expect(r.startMs).toBe(new Date(2026, 5, 12, 23, 0).getTime());
  });

  it("floors the start to nightFloorHHMM (default 02:00, configurable)", () => {
    // No data → base is window-start 23:00, but the floor holds it to 02:00.
    const r = bestNightStartMs({
      nowMs: now, nightWindow: nw, history: [], minDays: 3, floorHHMM: "02:00",
    });
    expect(r.reason).toBe("night-floor");
    expect(r.hour).toBe(2);
    // 02:00 is after midnight → the calendar day after the 23:00 window start
    expect(r.startMs).toBe(new Date(2026, 5, 13, 2, 0).getTime());
  });

  it("keeps a low-usage hour later than the floor", () => {
    // low-usage hour computed as 04:00 (> 02:00 floor) → not overridden
    const hist: HistoryPoint[] = [];
    for (let day = 8; day <= 11; day++) {
      hist.push({ ts: new Date(2026, 5, day, 1, 0).getTime(), pct: 0, resetEpochMs: null });
      hist.push({ ts: new Date(2026, 5, day, 1, 30).getTime(), pct: 30, resetEpochMs: null });
      hist.push({ ts: new Date(2026, 5, day, 4, 0).getTime(), pct: 30, resetEpochMs: null });
      hist.push({ ts: new Date(2026, 5, day, 4, 30).getTime(), pct: 30, resetEpochMs: null });
    }
    const r = bestNightStartMs({
      nowMs: now, nightWindow: nw, history: hist, minDays: 3, floorHHMM: "02:00",
    });
    expect(r.reason).toBe("low-usage-hour");
    expect(r.hour).toBe(4);
  });

  it("targets the lowest-burn night hour once enough days exist", () => {
    // 4 days of history; burn concentrated at hour 1, near-zero at hour 4.
    const hist: HistoryPoint[] = [];
    for (let day = 8; day <= 11; day++) {
      // hour 1: big jumps
      hist.push({ ts: new Date(2026, 5, day, 1, 0).getTime(), pct: 0, resetEpochMs: null });
      hist.push({ ts: new Date(2026, 5, day, 1, 30).getTime(), pct: 30, resetEpochMs: null });
      // hour 4: flat
      hist.push({ ts: new Date(2026, 5, day, 4, 0).getTime(), pct: 30, resetEpochMs: null });
      hist.push({ ts: new Date(2026, 5, day, 4, 30).getTime(), pct: 30, resetEpochMs: null });
    }
    const r = bestNightStartMs({ nowMs: now, nightWindow: nw, history: hist, minDays: 3 });
    expect(r.reason).toBe("low-usage-hour");
    expect(r.hour).toBe(4);
    // hour 4 falls after midnight → next calendar day relative to window start
    expect(r.startMs).toBe(new Date(2026, 5, 13, 4, 0).getTime());
  });
});

describe("confirmation phrases (spec gate wording, snapshot-fixed)", () => {
  const nw = { start: "23:00", end: "08:00" };

  it("write-scoped phrase states mode, isolation, and unattended night run", () => {
    expect(confirmPhrase("write-scoped", nw)).toMatchInlineSnapshot(
      `"확인: 이 태스크는 권한모드 "acceptEdits"로, git worktree 격리 하에 야간(23:00–08:00) 사람 개입 없이 무인 실행됩니다."`,
    );
  });

  it("read-only phrase states mode and unattended night run", () => {
    expect(confirmPhrase("read-only", nw)).toMatchInlineSnapshot(
      `"확인: 이 태스크는 권한모드 "default"로 야간(23:00–08:00) 사람 개입 없이 무인 실행됩니다."`,
    );
  });

  it("destructive phrase refuses unattended execution (gate 1 wording)", () => {
    expect(confirmPhrase("destructive", nw)).toMatchInlineSnapshot(
      `"이 태스크(destructive)는 무인 실행이 불가하여 야간 배치에서 제외됩니다. 실행은 사용자가 보는 앞에서 수동으로만 가능합니다."`,
    );
  });
});
