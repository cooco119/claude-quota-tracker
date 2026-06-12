import type { WindowKey, WindowReading } from "./types.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Classify a /usage output line into one of the three known windows.
 * Matches on keywords so minor wording changes don't break it.
 */
function classifyLine(line: string): WindowKey | null {
  const l = line.toLowerCase();
  // A window line mentions usage or a reset; this keeps raw lines around even
  // when the percent itself fails to parse.
  if (!l.includes("%") && !l.includes("used") && !l.includes("reset")) return null;
  if (l.includes("session")) return "session_5h";
  if (l.includes("week")) {
    if (l.includes("sonnet")) return "weekly_sonnet";
    return "weekly_all";
  }
  return null;
}

function parsePct(line: string): number | null {
  const m = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Convert wall-clock fields in an IANA timezone to epoch ms (two-pass offset
 * correction). Falls back to the system timezone when tz is missing/invalid.
 */
export function zonedTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | null,
): number {
  const asUtc = Date.UTC(year, month, day, hour, minute, 0, 0);
  if (!tz) return new Date(year, month, day, hour, minute).getTime();
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      hour12: false,
    });
  } catch {
    return new Date(year, month, day, hour, minute).getTime();
  }
  const offsetAt = (epoch: number): number => {
    const parts = fmt.formatToParts(epoch);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    const wall = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour") % 24, get("minute"), get("second"),
    );
    return wall - epoch;
  };
  // First pass with the UTC guess, second pass to settle near DST edges.
  let epoch = asUtc - offsetAt(asUtc);
  epoch = asUtc - offsetAt(epoch);
  return epoch;
}

/**
 * Parse a reset description like "Jun 11 at 10:49pm (Asia/Seoul)" or
 * "Jun 13 at 11am (Asia/Seoul)". The year is inferred: the closest occurrence
 * at or after (now - 1 day).
 */
export function parseResetEpochMs(line: string, nowMs: number): number | null {
  const m = line.match(
    /resets?\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase() ?? null;
  const tz = m[6] ?? null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const nowYear = new Date(nowMs).getUTCFullYear();
  // Try surrounding years, pick the first at or after now - 1 day.
  for (const year of [nowYear - 1, nowYear, nowYear + 1]) {
    const epoch = zonedTimeToEpochMs(year, month, day, hour, minute, tz);
    if (epoch >= nowMs - 24 * 60 * 60 * 1000) return epoch;
  }
  return null;
}

/**
 * Parse full `claude -p "/usage"` output into readings for the three known
 * windows. Lines that classify but fail to parse still produce a reading with
 * pct/reset null and raw preserved. Missing windows produce no reading.
 */
export function parseUsageOutput(text: string, nowMs: number): WindowReading[] {
  const readings: WindowReading[] = [];
  const seen = new Set<WindowKey>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const key = classifyLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    readings.push({
      windowKey: key,
      pct: parsePct(line),
      resetEpochMs: parseResetEpochMs(line, nowMs),
      raw: line,
    });
  }
  return readings;
}
