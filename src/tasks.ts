import type { Config, ExecutorConfig, NightWindow } from "./config.js";
import { isQuietHours } from "./notify.js";
import type { HistoryPoint } from "./store.js";
import type { PermissionClass } from "./types.js";

/**
 * Pure policy layer for the orchestrator (same philosophy as decideNudges:
 * no I/O, everything via arguments, fully testable).
 */

export interface TriageRule {
  permissionMode: string;
  unattendedOk: boolean;
  summary: string;
}

/** Enqueue-time permission triage: class -> mode + unattended verdict. */
export const TRIAGE: Record<PermissionClass, TriageRule> = {
  "read-only": {
    permissionMode: "default",
    unattendedOk: true,
    summary: "파일 읽기·분석·리포트만 (읽기 전용 도구로 제한)",
  },
  "write-scoped": {
    permissionMode: "acceptEdits",
    unattendedOk: true,
    summary: "저장소 파일 수정 (git worktree 격리)",
  },
  destructive: {
    // Manual-only. Still headless (-p) for estimation integrity, so
    // permission-requiring tools are denied fail-closed and recorded —
    // acceptEdits at least lets file edits proceed under supervision.
    permissionMode: "acceptEdits",
    unattendedOk: false,
    summary: "삭제·push·외부 발신 — 무인 실행 불가",
  },
};

/** Validate and parse an "HH:MM-HH:MM" range string. Null when invalid. */
export function parseHHMMRange(s: string): { start: string; end: string } | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh)}:${pad(em)}` };
}

/**
 * Wall-clock ms until the night window's end boundary. Only meaningful while
 * inside the window (used to refuse claiming tasks that cannot fit).
 */
export function msUntilWindowEnd(nowMs: number, nw: Pick<NightWindow, "end">): number {
  const [eh, em] = nw.end.split(":").map(Number);
  const end = new Date(nowMs);
  end.setHours(eh, em, 0, 0);
  if (end.getTime() <= nowMs) end.setDate(end.getDate() + 1);
  return end.getTime() - nowMs;
}

// ---- low-usage-hour scheduling for --night tasks ----

/** Epoch ms of the start-of-window for the night currently in effect at nowMs. */
export function activeNightStartMs(nowMs: number, startHHMM: string): number {
  const [sh, sm] = startHHMM.split(":").map(Number);
  const d = new Date(nowMs);
  d.setHours(sh, sm, 0, 0);
  // If now precedes today's start time, the active night began yesterday.
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Epoch of a given HH:MM within the active night (first occurrence ≥ window start). */
export function hhmmEpochInNight(winStartMs: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const t = new Date(winStartMs);
  t.setHours(h, m, 0, 0);
  if (t.getTime() < winStartMs) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/** Hours-of-day [0,23] covered by a night window [start,end), may wrap midnight. */
export function nightWindowHours(nw: Pick<NightWindow, "start" | "end">): number[] {
  const sh = Number(nw.start.split(":")[0]);
  const eh = Number(nw.end.split(":")[0]);
  const hours: number[] = [];
  let h = sh;
  for (let i = 0; i < 24 && h !== eh; i++) { hours.push(h); h = (h + 1) % 24; }
  return hours.length ? hours : [sh];
}

/** Average non-negative session burn (Δpct) by local hour-of-day. */
function hourlyBurn(history: HistoryPoint[]): Map<number, { sum: number; n: number }> {
  const m = new Map<number, { sum: number; n: number }>();
  for (let i = 1; i < history.length; i++) {
    const delta = history[i].pct - history[i - 1].pct;
    if (delta < 0) continue; // reset boundary
    const h = new Date(history[i].ts).getHours();
    const e = m.get(h) ?? { sum: 0, n: 0 };
    e.sum += delta; e.n += 1; m.set(h, e);
  }
  return m;
}

function distinctLocalDays(history: HistoryPoint[]): number {
  const s = new Set<string>();
  for (const p of history) {
    const d = new Date(p.ts);
    s.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return s.size;
}

/**
 * The epoch within tonight's window when a deferrable night task should start:
 * the lowest historical-burn hour of the night window. Until `minDays` of
 * history exist, returns the window start (run as soon as the window opens) —
 * picking an "optimal" hour off one day of data would be noise.
 */
export function bestNightStartMs(args: {
  nowMs: number;
  nightWindow: Pick<NightWindow, "start" | "end">;
  history: HistoryPoint[];
  minDays: number;
  /** Earliest local HH:MM execution may begin (default 02:00); floors the result. */
  floorHHMM?: string;
}): {
  startMs: number;
  reason: "window-start" | "low-usage-hour" | "night-floor";
  hour: number;
} {
  const { nowMs, nightWindow, history, minDays, floorHHMM } = args;
  const winStart = activeNightStartMs(nowMs, nightWindow.start);
  const startHour = Number(nightWindow.start.split(":")[0]);

  // Base start: window-start (too little data) or the lowest-burn observed hour.
  let baseMs = winStart;
  let reason: "window-start" | "low-usage-hour" = "window-start";
  let hour = startHour;
  if (distinctLocalDays(history) >= minDays) {
    const burn = hourlyBurn(history);
    // Only compare hours we have observations for; an unobserved hour is
    // unknown, not "zero burn".
    const hours = nightWindowHours(nightWindow).filter((h) => burn.has(h));
    if (hours.length > 0) {
      let best = hours[0];
      let bestVal = Infinity;
      for (const h of hours) {
        const avg = burn.get(h)!.sum / burn.get(h)!.n;
        if (avg < bestVal) { bestVal = avg; best = h; }
      }
      baseMs = hhmmEpochInNight(winStart, `${best}:00`);
      reason = "low-usage-hour";
      hour = best;
    }
  }

  // Floor: never run before the configured earliest hour (default 02:00).
  if (floorHHMM) {
    const floorMs = hhmmEpochInNight(winStart, floorHHMM);
    if (floorMs > baseMs) {
      return { startMs: floorMs, reason: "night-floor", hour: Number(floorHHMM.split(":")[0]) };
    }
  }
  return { startMs: baseMs, reason, hour };
}

/**
 * The spec-mandated confirmation phrase, fixed as a constant so the gate
 * itself is a test target (snapshot-tested; do not reword casually).
 */
export function confirmPhrase(
  cls: PermissionClass,
  nightWindow: Pick<NightWindow, "start" | "end">,
): string {
  const rule = TRIAGE[cls];
  if (!rule.unattendedOk) {
    return (
      `이 태스크(${cls})는 무인 실행이 불가하여 야간 배치에서 제외됩니다. ` +
      `실행은 사용자가 보는 앞에서 수동으로만 가능합니다.`
    );
  }
  const isolation = cls === "write-scoped" ? ", git worktree 격리 하에" : "";
  return (
    `확인: 이 태스크는 권한모드 "${rule.permissionMode}"로${isolation} ` +
    `야간(${nightWindow.start}–${nightWindow.end}) 사람 개입 없이 무인 실행됩니다.`
  );
}

export function nightWindowConfirmPhrase(
  nightWindow: Pick<NightWindow, "start" | "end">,
  tz: string,
): string {
  return (
    `night window가 아직 컨펌되지 않았습니다. 컨펌 전까지 야간 배치는 실행되지 않습니다.\n` +
    `  제안 창: ${nightWindow.start} – ${nightWindow.end}\n` +
    `  시스템 타임존: ${tz}\n` +
    `이 창과 타임존으로 야간 무인 실행을 허용합니까?`
  );
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

export function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Gate: night dispatch refused until the window is confirmed in this tz. */
export function nightWindowConfirmed(nw: NightWindow, currentTz: string): GateVerdict {
  if (!nw.confirmedAt) return { ok: false, reason: "night window not confirmed" };
  if (nw.confirmedTz !== currentTz) {
    return {
      ok: false,
      reason: `timezone changed (${nw.confirmedTz} → ${currentTz}); re-confirm night window`,
    };
  }
  return { ok: true };
}

/** Is `nowMs` inside the night window? Same wall-clock semantics as quiet hours. */
export function inNightWindow(nowMs: number, nw: Pick<NightWindow, "start" | "end">): boolean {
  return isQuietHours(nowMs, { start: nw.start, end: nw.end });
}

export interface GuardInput {
  nowMs: number;
  sessionPct: number | null;
  sessionResetMs: number | null;
  weeklyPct: number | null;
  weeklyResetMs: number | null;
}

/**
 * Window guard, asymmetric by design: the session window is the binding
 * constraint (everything stops when it fills), the weekly window is the fill
 * target so it only blocks near exhaustion.
 */
export function windowGuard(input: GuardInput, cfg: ExecutorConfig): GateVerdict {
  const { sessionPct, weeklyPct } = input;
  if (sessionPct === null || weeklyPct === null) {
    return { ok: false, reason: "usage data missing (cannot read session/weekly pct)" };
  }
  if (sessionPct >= cfg.sessionGuardPct) {
    return {
      ok: false,
      reason: `session window at ${sessionPct}% >= guard ${cfg.sessionGuardPct}%; pause until reset`,
    };
  }
  if (weeklyPct >= cfg.weeklyGuardPct) {
    return {
      ok: false,
      reason: `weekly window at ${weeklyPct}% >= guard ${cfg.weeklyGuardPct}%; pause until reset`,
    };
  }
  return { ok: true };
}

/** latest.json freshness: stale usage data must not authorize a launch. */
export function isLatestFresh(
  generatedAtMs: number,
  nowMs: number,
  pollIntervalSeconds: number,
): boolean {
  return nowMs - generatedAtMs <= 2 * pollIntervalSeconds * 1000;
}

export interface ExecutorGateInput {
  nowMs: number;
  config: Config;
  currentTz: string;
  latestGeneratedAtMs: number | null;
  guard: GuardInput;
  hasClaimableTask: boolean;
  hasLiveRunningTask: boolean;
}

/** Full pre-spawn gate chain, evaluated by the poller hook and the executor loop. */
export function shouldRunExecutor(input: ExecutorGateInput): GateVerdict {
  const { config, nowMs, currentTz } = input;
  if (!config.executor.enabled) return { ok: false, reason: "executor disabled" };
  if (!inNightWindow(nowMs, config.nightWindow)) {
    return { ok: false, reason: "outside night window" };
  }
  const confirmed = nightWindowConfirmed(config.nightWindow, currentTz);
  if (!confirmed.ok) return confirmed;
  if (
    input.latestGeneratedAtMs === null ||
    !isLatestFresh(input.latestGeneratedAtMs, nowMs, config.pollIntervalSeconds)
  ) {
    return { ok: false, reason: "latest.json missing or stale" };
  }
  const guard = windowGuard(input.guard, config.executor);
  if (!guard.ok) return guard;
  if (!input.hasClaimableTask) return { ok: false, reason: "no claimable task" };
  if (input.hasLiveRunningTask) return { ok: false, reason: "a task is already running" };
  return { ok: true };
}
