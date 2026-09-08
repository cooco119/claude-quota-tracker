import { describe, expect, it } from "vitest";
import { admitTask, compareScheduledTasks, continuousEligible } from "../src/scheduler-policy.js";
import type { Task } from "../src/types.js";
import type { TaskScheduleMeta } from "../src/scheduler-meta.js";

const NOW = Date.UTC(2026, 8, 7, 20, 0, 0);
const task: Task = {
  id: 1, createdTs: NOW - 1000, updatedTs: NOW - 1000,
  prompt: "x", cwd: "/tmp/repo", size: "m", priority: 0, deferOk: true,
  permissionClass: "read-only", permissionMode: "default", unattendedOk: true,
  scheduledWindow: "any", status: "queued", attempts: 0,
  resumeSessionId: null, worktreePath: null, lastError: null,
};
const meta: TaskScheduleMeta = {
  taskId: 1, intent: "opportunistic", deadlineMs: null, estimatedTokens: null,
  paused: false, continuousOk: true, createdTs: NOW, updatedTs: NOW,
};
const pacedOk = { ok: true as const, windows: [] };
const pacedHold = { ok: false as const, reason: "weekly pacing hold", windows: [] };

describe("scheduler admission", () => {
  it("holds opportunistic work when pacing is ahead", () => {
    expect(admitTask({ nowMs: NOW, task, meta, pacing: pacedHold, estimatedMinutes: 20, deadlineSafetyMinutes: 10 }).ok).toBe(false);
  });

  it("allows opportunistic work with spare pacing budget", () => {
    expect(admitTask({ nowMs: NOW, task, meta, pacing: pacedOk, estimatedMinutes: 20, deadlineSafetyMinutes: 10 }).ok).toBe(true);
  });

  it("urgent deadline bypasses pacing", () => {
    const deadline = { ...meta, intent: "deadline" as const, deadlineMs: NOW + 25 * 60_000 };
    const v = admitTask({ nowMs: NOW, task, meta: deadline, pacing: pacedHold, estimatedMinutes: 20, deadlineSafetyMinutes: 10 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.bypassedPacing).toBe(true);
  });

  it("non-urgent deadline still obeys pacing", () => {
    const deadline = { ...meta, intent: "deadline" as const, deadlineMs: NOW + 3 * 60 * 60_000 };
    expect(admitTask({ nowMs: NOW, task, meta: deadline, pacing: pacedHold, estimatedMinutes: 20, deadlineSafetyMinutes: 10 }).ok).toBe(false);
  });

  it("paused tasks never admit", () => {
    expect(admitTask({ nowMs: NOW, task, meta: { ...meta, paused: true }, pacing: pacedOk, estimatedMinutes: 20, deadlineSafetyMinutes: 10 }).ok).toBe(false);
  });
});

describe("continuous eligibility and ordering", () => {
  it("requires explicit continuous opt-in and unattended permission", () => {
    expect(continuousEligible(task, meta)).toBe(true);
    expect(continuousEligible(task, { ...meta, continuousOk: false })).toBe(false);
    expect(continuousEligible({ ...task, unattendedOk: false }, meta)).toBe(false);
    expect(continuousEligible(task, { ...meta, intent: "interactive" })).toBe(false);
  });

  it("orders deadline tasks by earliest deadline ahead of opportunistic work", () => {
    const urgent = { task: { ...task, id: 2 }, meta: { ...meta, taskId: 2, intent: "deadline" as const, deadlineMs: NOW + 60_000 } };
    const opportunistic = { task, meta };
    expect(compareScheduledTasks(urgent, opportunistic)).toBeLessThan(0);
  });
});
