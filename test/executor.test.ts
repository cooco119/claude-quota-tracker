import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { executeTask, recoverStaleRunning } from "../src/executor.js";
import type { ExecFn } from "../src/runner.js";
import { Store } from "../src/store.js";
import type { GuardInput } from "../src/tasks.js";
import type { TaskInput } from "../src/types.js";

const CONFIG: Config = DEFAULT_CONFIG;
const GUARD: GuardInput = {
  nowMs: 0, sessionPct: 20, sessionResetMs: 1, weeklyPct: 50, weeklyResetMs: 1,
};

const SUCCESS_JSON = JSON.stringify({
  type: "result", subtype: "success", is_error: false, duration_ms: 100,
  result: "ok", session_id: "sess-ok", total_cost_usd: 0.01,
  usage: {
    input_tokens: 10, output_tokens: 5,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  },
  modelUsage: { "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 5 } },
  permission_denials: [],
});

const okExec: ExecFn = async () => ({ stdout: SUCCESS_JSON, stderr: "", exitCode: 0 });
const failExec: ExecFn = async () => ({ stdout: "", stderr: "boom", exitCode: 1 });

function input(partial: Partial<TaskInput> = {}): TaskInput {
  return {
    prompt: "p", cwd: "/tmp", size: "xs", priority: 0, deferOk: true,
    permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
    scheduledWindow: "night",
    ...partial,
  };
}

describe("recoverStaleRunning", () => {
  it("leaves freshly claimed tasks alone (grace period) — double-run guard", () => {
    const store = new Store(":memory:");
    store.enqueueTask(Date.now(), input());
    store.claimNextTask(Date.now()); // claimed seconds ago, no run row yet
    recoverStaleRunning(store, Date.now(), CONFIG.executor);
    expect(store.listTasks(["running"])).toHaveLength(1); // NOT demoted
    store.close();
  });

  it("trusts a live pid with an unfinished run row", () => {
    const store = new Store(":memory:");
    const old = Date.now() - 10 * 60 * 1000;
    const t = store.enqueueTask(old, input());
    store.claimNextTask(old);
    store.startRun({
      ts: Date.now() - 60_000, taskId: t.id, pid: process.pid,
      sizeAtRun: "xs", sessionPctBefore: 1, weeklyPctBefore: 1,
    });
    recoverStaleRunning(store, Date.now(), CONFIG.executor);
    expect(store.getTask(t.id)?.status).toBe("running");
    store.close();
  });

  it("recovers a task whose pid is dead, to carried_over", () => {
    const store = new Store(":memory:");
    const old = Date.now() - 10 * 60 * 1000;
    const t = store.enqueueTask(old, input());
    store.claimNextTask(old);
    store.startRun({
      ts: old, taskId: t.id, pid: 999999999,
      sizeAtRun: "xs", sessionPctBefore: 1, weeklyPctBefore: 1,
    });
    recoverStaleRunning(store, Date.now(), CONFIG.executor);
    expect(store.getTask(t.id)?.status).toBe("carried_over");
    store.close();
  });

  it("recovers a live-pid task that overran its timeout 1.5x (pid reuse)", () => {
    const store = new Store(":memory:");
    const old = Date.now() - 60 * 60 * 1000; // xs timeout 5m, started 1h ago
    const t = store.enqueueTask(old, input({ size: "xs" }));
    store.claimNextTask(old);
    store.startRun({
      ts: old, taskId: t.id, pid: process.pid, // alive, but way past 5m * 1.5
      sizeAtRun: "xs", sessionPctBefore: 1, weeklyPctBefore: 1,
    });
    recoverStaleRunning(store, Date.now(), CONFIG.executor);
    expect(store.getTask(t.id)?.status).toBe("carried_over");
    store.close();
  });

  it("sends crash-looping tasks to terminal failed once maxAttempts is reached", () => {
    const store = new Store(":memory:");
    const old = Date.now() - 10 * 60 * 1000;
    const t = store.enqueueTask(old, input());
    // Simulate maxAttempts(3) prior claims, each dying without recovery.
    for (let i = 0; i < CONFIG.executor.maxAttempts - 1; i++) {
      store.claimNextTask(old);
      store.settleTask({ ts: old, taskId: t.id, status: "carried_over", lastError: "x" });
    }
    store.claimNextTask(old); // attempts now == maxAttempts, dies again
    recoverStaleRunning(store, Date.now(), CONFIG.executor);
    expect(store.getTask(t.id)?.status).toBe("failed");
    store.close();
  });
});

describe("executeTask", () => {
  it("records actuals and settles done on success", async () => {
    const store = new Store(":memory:");
    store.enqueueTask(Date.now(), input());
    const task = store.claimNextTask(Date.now())!;
    const ok = await executeTask(store, task, CONFIG, GUARD, { exec: okExec });
    expect(ok).toBe(true);
    const after = store.getTask(task.id)!;
    expect(after.status).toBe("done");
    expect(after.resumeSessionId).toBe("sess-ok");
    const recs = store.estimationRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].actualTokens).toBe(15);
    store.close();
  });

  it("carries over on failure, then fails terminally at maxAttempts", async () => {
    const store = new Store(":memory:");
    store.enqueueTask(Date.now(), input());
    for (let attempt = 1; attempt <= CONFIG.executor.maxAttempts; attempt++) {
      const task = store.claimNextTask(Date.now())!;
      const ok = await executeTask(store, task, CONFIG, GUARD, { exec: failExec });
      expect(ok).toBe(false);
      const status = store.getTask(task.id)!.status;
      expect(status).toBe(attempt < CONFIG.executor.maxAttempts ? "carried_over" : "failed");
    }
    expect(store.hasClaimableTask()).toBe(false);
    store.close();
  });

  it("records a failed run (no claude call) when worktree setup fails", async () => {
    const store = new Store(":memory:");
    let claudeCalled = false;
    const exec: ExecFn = async (bin) => {
      if (bin === "git") return { stdout: "", stderr: "not a repo", exitCode: 128 };
      claudeCalled = true;
      return { stdout: SUCCESS_JSON, stderr: "", exitCode: 0 };
    };
    store.enqueueTask(Date.now(), input({
      permissionClass: "write-scoped", permissionMode: "acceptEdits",
    }));
    const task = store.claimNextTask(Date.now())!;
    const ok = await executeTask(store, task, CONFIG, GUARD, { exec });
    expect(ok).toBe(false);
    expect(claudeCalled).toBe(false);
    expect(store.getTask(task.id)?.status).toBe("carried_over");
    expect(store.getTask(task.id)?.lastError).toContain("worktree");
    const run = store.latestRunForTask(task.id);
    expect(run?.endedTs).not.toBeNull(); // run row exists and is closed
    store.close();
  });

  it("creates the run row before slow work (stale recovery sees a live pid)", async () => {
    const store = new Store(":memory:");
    store.enqueueTask(Date.now(), input({
      permissionClass: "write-scoped", permissionMode: "acceptEdits",
    }));
    const task = store.claimNextTask(Date.now())!;
    let runRowDuringWorktree: ReturnType<Store["latestRunForTask"]> = null;
    const exec: ExecFn = async (bin) => {
      if (bin === "git") {
        runRowDuringWorktree = store.latestRunForTask(task.id);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: SUCCESS_JSON, stderr: "", exitCode: 0 };
    };
    await executeTask(store, task, CONFIG, GUARD, { exec });
    expect(runRowDuringWorktree).not.toBeNull();
    expect(runRowDuringWorktree!.pid).toBe(process.pid);
    expect(runRowDuringWorktree!.endedTs).toBeNull();
    store.close();
  });
});
