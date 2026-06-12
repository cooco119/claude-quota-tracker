import { describe, expect, it } from "vitest";
import * as api from "../src/dashboard-api.js";
import { Store } from "../src/store.js";
import type { RunActuals, TaskInput } from "../src/types.js";

function input(p: Partial<TaskInput> = {}): TaskInput {
  return {
    prompt: "p", cwd: "/tmp", size: "m", priority: 0, deferOk: true,
    permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
    scheduledWindow: "night", ...p,
  };
}

function seedRun(store: Store, startedTs: number, model: string, tokens: {
  input: number; output: number; cacheCreation: number; cacheRead: number; cost: number;
}, size: TaskInput["size"] = "m"): void {
  const t = store.enqueueTask(startedTs, input({ size }));
  store.claimNextTask(startedTs);
  const runId = store.startRun({
    ts: startedTs, taskId: t.id, pid: 1, sizeAtRun: size,
    sessionPctBefore: 10, weeklyPctBefore: 20,
  });
  const actuals: RunActuals = {
    model, sessionId: "s", inputTokens: tokens.input, outputTokens: tokens.output,
    cacheCreationTokens: tokens.cacheCreation, cacheReadTokens: tokens.cacheRead,
    totalCostUsd: tokens.cost, durationMs: 1000, result: "success",
    error: null, rawJson: "{}",
  };
  store.finishRun(runId, startedTs + 1000, actuals);
  store.settleTask({ ts: startedTs + 1000, taskId: t.id, status: "done" });
}

describe("dashboard-api empty state (no rows — must not throw)", () => {
  it("returns valid empty payloads", () => {
    const store = new Store(":memory:");
    const now = 1_700_000_000_000;
    // windows come from latest.json (env state); KPI is the store-derived part.
    const ov = api.overview(store, now);
    expect(ov.kpi).toEqual({ cost7d: 0, tokens7d: 0, runs7d: 0 });
    expect(Array.isArray(ov.windows)).toBe(true);
    expect(api.models(store, now - 1000, now).totals).toEqual([]);
    expect(api.contrib(store, now - 86400000, now, "tokens").days.length).toBeGreaterThan(0);
    expect(api.estimates(store).summary).toEqual([]);
    expect(api.queue(store).queued).toBe(0);
    store.close();
  });
});

describe("dashboard-api with data", () => {
  const now = 1_700_000_000_000;

  it("aggregates model totals and token categories", () => {
    const store = new Store(":memory:");
    seedRun(store, now - 1000, "claude-fable-5",
      { input: 100, output: 50, cacheCreation: 200, cacheRead: 10, cost: 0.5 });
    seedRun(store, now - 2000, "claude-sonnet-4-6",
      { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, cost: 0.01 });
    const m = api.models(store, now - 10000, now);
    expect(m.totals).toHaveLength(2);
    expect(m.totals[0].model).toBe("claude-fable-5"); // sorted by cost desc
    expect(m.totals[0].totalTokens).toBe(360); // 100+50+200+10 (all 4 categories)
    expect(m.categories).toEqual({ input: 110, output: 55, cacheCreation: 200, cacheRead: 10 });
    store.close();
  });

  it("buckets contribution by local day with gaps filled", () => {
    const store = new Store(":memory:");
    const day = 86400000;
    seedRun(store, now - 3 * day, "m1",
      { input: 100, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0.1 });
    seedRun(store, now, "m1",
      { input: 50, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0.05 });
    const c = api.contrib(store, now - 3 * day, now, "tokens");
    expect(c.days.length).toBeGreaterThanOrEqual(4); // continuous grid
    const nonzero = c.days.filter((d) => d.value > 0);
    expect(nonzero.length).toBe(2);
    expect(c.days.some((d) => d.value === 0)).toBe(true); // gap filled
    store.close();
  });

  it("caps the contribution grid for huge/malformed ranges (DoS guard)", () => {
    const store = new Store(":memory:");
    const c = api.contrib(store, 0, now, "tokens"); // ~54 years if uncapped
    expect(c.days.length).toBeLessThanOrEqual(370);
    store.close();
  });

  it("averages the two middle ratios for even-count samples", () => {
    const store = new Store(":memory:");
    // size m estimate 60000; two runs at 30000 (0.5x) and 90000 (1.5x) -> median 1.0
    seedRun(store, now - 1000, "m1",
      { input: 30000, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0.1 }, "m");
    seedRun(store, now, "m1",
      { input: 90000, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0.1 }, "m");
    const e = api.estimates(store);
    expect(e.summary[0].n).toBe(2);
    expect(e.summary[0].medianRatio).toBeCloseTo(1.0, 5);
    store.close();
  });

  it("summarizes estimate-vs-actual ratio per size", () => {
    const store = new Store(":memory:");
    // size m estimate = 60000 tokens; actual 30000 -> ratio 0.5
    seedRun(store, now, "m1",
      { input: 30000, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0.1 }, "m");
    const e = api.estimates(store);
    expect(e.summary).toHaveLength(1);
    expect(e.summary[0].size).toBe("m");
    expect(e.summary[0].medianRatio).toBeCloseTo(0.5, 2);
    store.close();
  });

  it("computes 7-day KPI totals in overview", () => {
    const store = new Store(":memory:");
    seedRun(store, now - 1000, "m1",
      { input: 1000, output: 500, cacheCreation: 0, cacheRead: 0, cost: 0.25 });
    const ov = api.overview(store, now);
    expect(ov.kpi.runs7d).toBe(1);
    expect(ov.kpi.tokens7d).toBe(1500);
    expect(ov.kpi.cost7d).toBeCloseTo(0.25);
    store.close();
  });
});
