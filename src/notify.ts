import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { NotifyConfig, QuietHours } from "./config.js";
import type { Forecast } from "./forecast.js";
import type { WindowKey } from "./types.js";

export type NudgeMode = "underUse" | "overUse" | "scheduleHint";

export interface Nudge {
  mode: NudgeMode;
  windowKey: WindowKey;
  title: string;
  message: string;
}

export interface NudgeInput {
  windowKey: WindowKey;
  pct: number;
  resetEpochMs: number;
  windowDurationMs: number;
  forecast: Forecast;
}

/** Map of "windowKey:mode" -> last sent epoch ms. */
export type NotifyState = Record<string, number>;

const WINDOW_LABEL: Record<WindowKey, string> = {
  session_5h: "5h session",
  weekly_all: "weekly (all models)",
  weekly_sonnet: "weekly (Sonnet)",
};

export function isQuietHours(nowMs: number, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const now = new Date(nowMs);
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMin(quiet.start);
  const end = toMin(quiet.end);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // crosses midnight
}

/**
 * Pure nudge decision: which notifications should fire right now.
 * Quiet hours and per-(window, mode) cooldown are applied here so the whole
 * policy is testable without touching macOS notifications.
 */
export function decideNudges(args: {
  nowMs: number;
  items: NudgeInput[];
  config: NotifyConfig;
  state: NotifyState;
}): Nudge[] {
  const { nowMs, items, config, state } = args;
  if (isQuietHours(nowMs, config.quietHours)) return [];
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const nudges: Nudge[] = [];

  const onCooldown = (windowKey: WindowKey, mode: NudgeMode): boolean => {
    const last = state[`${windowKey}:${mode}`];
    return last !== undefined && nowMs - last < cooldownMs;
  };

  for (const item of items) {
    const { windowKey, pct, resetEpochMs, windowDurationMs, forecast } = item;
    const remainingMs = resetEpochMs - nowMs;
    if (remainingMs <= 0) continue;
    const elapsedFraction = 1 - remainingMs / windowDurationMs;
    const label = WINDOW_LABEL[windowKey];
    const resetStr = new Date(resetEpochMs).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });

    if (
      config.underUse.enabled &&
      elapsedFraction >= config.minElapsedFraction &&
      forecast.predictedPctAtReset < config.underUse.thresholdPct &&
      !onCooldown(windowKey, "underUse")
    ) {
      nudges.push({
        mode: "underUse",
        windowKey,
        title: `Claude quota under-used: ${label}`,
        message:
          `At ${pct}% now, on pace for ~${Math.round(forecast.predictedPctAtReset)}% ` +
          `by reset (${resetStr}). Spare capacity available.`,
      });
    }

    if (
      config.overUse.enabled &&
      forecast.predictedPctAtReset >= config.overUse.thresholdPct &&
      pct < 100 &&
      !onCooldown(windowKey, "overUse")
    ) {
      nudges.push({
        mode: "overUse",
        windowKey,
        title: `Claude quota at risk: ${label}`,
        message:
          `At ${pct}% now, on pace to hit ${config.overUse.thresholdPct}% ` +
          `before reset (${resetStr}).`,
      });
    }

    if (
      config.scheduleHint.enabled &&
      windowKey === "session_5h" &&
      pct < 20 &&
      remainingMs > windowDurationMs / 2 &&
      !onCooldown(windowKey, "scheduleHint")
    ) {
      nudges.push({
        mode: "scheduleHint",
        windowKey,
        title: "Good time for heavy Claude work",
        message:
          `Session window is fresh (${pct}%) with ` +
          `${Math.round(remainingMs / 3600000)}h+ left before reset.`,
      });
    }
  }
  return nudges;
}

/** Record sent nudges into state (mutates and returns it). */
export function markSent(state: NotifyState, nudges: Nudge[], nowMs: number): NotifyState {
  for (const n of nudges) state[`${n.windowKey}:${n.mode}`] = nowMs;
  return state;
}

export function loadNotifyState(path: string): NotifyState {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function saveNotifyState(path: string, state: NotifyState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Deliver via macOS notification (osascript; no terminal-notifier dependency). */
export function sendMacNotification(nudge: Nudge): Promise<void> {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script =
    `display notification "${esc(nudge.message)}" with title "${esc(nudge.title)}"`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], () => resolve());
  });
}
