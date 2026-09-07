import type { Task } from "./types.js";
import type { TaskScheduleMeta } from "./scheduler-meta.js";
import type { PacingVerdict } from "./pacing.js";

export type AdmissionVerdict =
  | { ok: true; reason: string; bypassedPacing: boolean }
  | { ok: false; reason: string; bypassedPacing: false };

/**
 * Decide whether an otherwise safe/eligible task may start now.
 * Hard quota guards and permission safety are deliberately evaluated outside
 * this function and remain authoritative.
 */
export function admitTask(args: {
  nowMs: number;
  task: Task;
  meta: TaskScheduleMeta;
  pacing: PacingVerdict;
  estimatedMinutes: number;
  deadlineSafetyMinutes: number;
}): AdmissionVerdict {
  const { nowMs, meta, pacing } = args;
  if (meta.paused) return { ok: false, reason: "task paused", bypassedPacing: false };

  if (meta.intent === "interactive") {
    return { ok: true, reason: "interactive task bypasses pacing", bypassedPacing: true };
  }

  if (meta.intent === "deadline") {
    if (meta.deadlineMs === null) {
      return { ok: false, reason: "deadline task has no deadline", bypassedPacing: false };
    }
    const latestSafeStart = meta.deadlineMs -
      (args.estimatedMinutes + args.deadlineSafetyMinutes) * 60_000;
    if (nowMs >= latestSafeStart) {
      return { ok: true, reason: "deadline requires immediate start", bypassedPacing: true };
    }
    if (!pacing.ok) return { ok: false, reason: pacing.reason, bypassedPacing: false };
    return { ok: true, reason: "deadline task fits pacing budget", bypassedPacing: false };
  }

  if (!pacing.ok) return { ok: false, reason: pacing.reason, bypassedPacing: false };
  return { ok: true, reason: "opportunistic task fits pacing budget", bypassedPacing: false };
}

/** Continuous unattended execution is explicit opt-in and never applies to interactive tasks. */
export function continuousEligible(task: Task, meta: TaskScheduleMeta): boolean {
  return task.unattendedOk && meta.continuousOk && meta.intent !== "interactive" && !meta.paused;
}

/**
 * Deadline work is ordered by earliest deadline, then normal queue priority.
 * Opportunistic work retains the existing priority/FIFO behavior.
 */
export function compareScheduledTasks(
  a: { task: Task; meta: TaskScheduleMeta },
  b: { task: Task; meta: TaskScheduleMeta },
): number {
  const ad = a.meta.intent === "deadline" ? (a.meta.deadlineMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  const bd = b.meta.intent === "deadline" ? (b.meta.deadlineMs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;
  if (a.task.priority !== b.task.priority) return b.task.priority - a.task.priority;
  return a.task.createdTs - b.task.createdTs;
}
