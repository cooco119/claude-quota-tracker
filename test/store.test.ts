import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import type { TaskInput, WindowReading } from "../src/types.js";

function reading(partial: Partial<WindowReading>): WindowReading {
  return {
    windowKey: "session_5h",
    pct: 10,
    resetEpochMs: 1_000,
    raw: "raw line",
    ...partial,
  };
}

describe("Store (in-memory)", () => {
  it("appends snapshots and reads back history in order", () => {
    const store = new Store(":memory:");
    store.appendSnapshot(100, "claude", [reading({ pct: 10 })]);
    store.appendSnapshot(200, "claude", [reading({ pct: 12 })]);
    store.appendSnapshot(300, "claude", [reading({ pct: 15 })]);
    const hist = store.history("claude", "session_5h", 0);
    expect(hist.map((h) => [h.ts, h.pct])).toEqual([
      [100, 10], [200, 12], [300, 15],
    ]);
    store.close();
  });

  it("filters history by since-timestamp and window key", () => {
    const store = new Store(":memory:");
    store.appendSnapshot(100, "claude", [
      reading({ windowKey: "session_5h", pct: 10 }),
      reading({ windowKey: "weekly_all", pct: 50 }),
    ]);
    store.appendSnapshot(200, "claude", [
      reading({ windowKey: "session_5h", pct: 20 }),
    ]);
    expect(store.history("claude", "session_5h", 150)).toHaveLength(1);
    expect(store.history("claude", "weekly_all", 0)).toHaveLength(1);
    expect(store.history("other", "session_5h", 0)).toHaveLength(0);
    store.close();
  });

  it("stores null pct/reset readings with raw preserved, excluded from history", () => {
    const store = new Store(":memory:");
    store.appendSnapshot(100, "claude", [
      reading({ pct: null, resetEpochMs: null, raw: "unparseable line" }),
    ]);
    expect(store.history("claude", "session_5h", 0)).toHaveLength(0);
    const latest = store.latest("claude");
    expect(latest).toHaveLength(1);
    expect(latest[0].raw).toBe("unparseable line");
    expect(latest[0].pct).toBeNull();
    store.close();
  });

  it("creates the Part B tables on a fresh database (DDL smoke)", () => {
    // `defer_ok` naming matters: `deferrable` is a SQLite reserved word and
    // would crash the shared constructor — and with it the Part A poller.
    const store = new Store(":memory:");
    expect(store.listTasks()).toEqual([]);
    expect(store.hasClaimableTask()).toBe(false);
    store.close();
  });

  it("latest() returns only the most recent snapshot's readings", () => {
    const store = new Store(":memory:");
    store.appendSnapshot(100, "claude", [reading({ pct: 10 })]);
    store.appendSnapshot(200, "claude", [
      reading({ windowKey: "session_5h", pct: 20 }),
      reading({ windowKey: "weekly_sonnet", pct: 5 }),
    ]);
    const latest = store.latest("claude");
    expect(latest).toHaveLength(2);
    expect(latest.every((r) => r.ts === 200)).toBe(true);
    store.close();
  });
});

function taskInput(partial: Partial<TaskInput>): TaskInput {
  return {
    prompt: "do something", cwd: "/tmp", size: "xs", priority: 0, deferOk: true,
    permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
    scheduledWindow: "night",
    ...partial,
  };
}

describe("Store task queue (in-memory)", () => {
  it("enqueues and claims by priority DESC then created_ts ASC", () => {
    const store = new Store(":memory:");
    store.enqueueTask(100, taskInput({ prompt: "low-old", priority: 0 }));
    store.enqueueTask(200, taskInput({ prompt: "high", priority: 5 }));
    store.enqueueTask(300, taskInput({ prompt: "low-new", priority: 0 }));
    expect(store.claimNextTask(400)?.prompt).toBe("high");
    expect(store.claimNextTask(401)?.prompt).toBe("low-old");
    expect(store.claimNextTask(402)?.prompt).toBe("low-new");
    expect(store.claimNextTask(403)).toBeNull();
    store.close();
  });

  it("never lets unattended-unsafe (destructive) tasks be claimed — gate 1", () => {
    const store = new Store(":memory:");
    store.enqueueTask(100, taskInput({
      permissionClass: "destructive", unattendedOk: false, scheduledWindow: "any",
    }));
    expect(store.hasClaimableTask()).toBe(false);
    expect(store.claimNextTask(200)).toBeNull();
    store.close();
  });

  it("claims 'any'-window unattended tasks too (night ⊂ any; deferOk=false ≠ night 제외)", () => {
    const store = new Store(":memory:");
    store.enqueueTask(100, taskInput({ deferOk: false, scheduledWindow: "any" }));
    expect(store.claimNextTask(200)?.scheduledWindow).toBe("any");
    store.close();
  });

  it("restricts claim to allowed sizes — skips a too-big head task (no head-of-line)", () => {
    const store = new Store(":memory:");
    // higher-priority xl ahead of a lower-priority xs
    store.enqueueTask(100, taskInput({ size: "xl", priority: 9, prompt: "big" }));
    store.enqueueTask(200, taskInput({ size: "xs", priority: 0, prompt: "small" }));
    // only xs/s fit the remaining window → xl is skipped, xs runs
    expect(store.peekNextTask(["xs", "s"])?.prompt).toBe("small");
    expect(store.claimNextTask(300, ["xs", "s"])?.prompt).toBe("small");
    // with no restriction the xl (higher priority) would have won
    const store2 = new Store(":memory:");
    store2.enqueueTask(100, taskInput({ size: "xl", priority: 9, prompt: "big" }));
    store2.enqueueTask(200, taskInput({ size: "xs", priority: 0, prompt: "small" }));
    expect(store2.claimNextTask(300)?.prompt).toBe("big");
    store.close(); store2.close();
  });

  it("claims atomically: a claimed task cannot be claimed twice", () => {
    const store = new Store(":memory:");
    const t = store.enqueueTask(100, taskInput({}));
    expect(store.claimNextTask(200)?.id).toBe(t.id);
    expect(store.claimNextTask(201)).toBeNull(); // status=running now
    store.close();
  });

  it("carried_over tasks are claimable again with attempts counted", () => {
    const store = new Store(":memory:");
    const t = store.enqueueTask(100, taskInput({}));
    store.claimNextTask(200);
    store.settleTask({ ts: 300, taskId: t.id, status: "carried_over", lastError: "night ended" });
    const again = store.claimNextTask(400);
    expect(again?.id).toBe(t.id);
    expect(again?.attempts).toBe(2);
    store.close();
  });

  it("records run actuals and exposes estimate-vs-actual records", () => {
    const store = new Store(":memory:");
    const t = store.enqueueTask(100, taskInput({ size: "m" }));
    store.claimNextTask(200);
    const runId = store.startRun({
      ts: 200, taskId: t.id, pid: 1234, sizeAtRun: "m",
      sessionPctBefore: 20, weeklyPctBefore: 50,
    });
    store.finishRun(runId, 900, {
      model: "claude-sonnet-4-6", sessionId: "sess-1",
      inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 200,
      cacheReadTokens: 0, totalCostUsd: 0.12, durationMs: 700,
      result: "success", error: null, rawJson: "{}",
    });
    store.settleTask({ ts: 900, taskId: t.id, status: "done", resumeSessionId: "sess-1" });

    const recs = store.estimationRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].size).toBe("m");
    expect(recs[0].estimateTokens).toBe(60_000);
    expect(recs[0].actualTokens).toBe(1700);
    expect(recs[0].model).toBe("claude-sonnet-4-6");
    expect(store.getTask(t.id)?.status).toBe("done");
    expect(store.getTask(t.id)?.resumeSessionId).toBe("sess-1");
    store.close();
  });

  it("settleTask COALESCE preserves resume/worktree across later settles", () => {
    const store = new Store(":memory:");
    const t = store.enqueueTask(100, taskInput({}));
    store.claimNextTask(200);
    store.settleTask({
      ts: 300, taskId: t.id, status: "carried_over",
      resumeSessionId: "sess-A", worktreePath: "/wt/A", lastError: "first error",
    });
    store.claimNextTask(400);
    store.settleTask({
      ts: 500, taskId: t.id, status: "carried_over",
      resumeSessionId: null, worktreePath: null, lastError: "second error",
    });
    const after = store.getTask(t.id)!;
    expect(after.resumeSessionId).toBe("sess-A"); // preserved
    expect(after.worktreePath).toBe("/wt/A"); // preserved
    expect(after.lastError).toBe("second error"); // replaced
    store.close();
  });

  it("peekNextTask matches claim order without claiming", () => {
    const store = new Store(":memory:");
    store.enqueueTask(100, taskInput({ prompt: "a", priority: 1 }));
    store.enqueueTask(200, taskInput({ prompt: "b", priority: 9 }));
    expect(store.peekNextTask()?.prompt).toBe("b");
    expect(store.peekNextTask()?.status).toBe("queued"); // still unclaimed
    store.close();
  });
});
