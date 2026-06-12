import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DB_PATH, LATEST_JSON_PATH } from "./config.js";
import { exhaustionEpochMs, type Forecast } from "./forecast.js";
import { isSea } from "./sea.js";
import { Store, type HistoryPoint } from "./store.js";
import { WINDOW_DURATION_MS, type WindowKey, type WindowReading } from "./types.js";

interface LatestWindow extends WindowReading {
  forecast: Forecast | null;
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";
const GLANCE_LABEL: Record<WindowKey, string> = {
  session_5h: "5h",
  weekly_all: "wk",
  weekly_sonnet: "son",
};
const FULL_LABEL: Record<WindowKey, string> = {
  session_5h: "Session (5h)",
  weekly_all: "Week (all models)",
  weekly_sonnet: "Week (Sonnet)",
};

export function sparkline(points: HistoryPoint[], buckets = 16): string {
  if (points.length === 0) return "no history";
  const first = points[0].ts;
  const last = points[points.length - 1].ts;
  const span = Math.max(1, last - first);
  const cells: number[][] = Array.from({ length: buckets }, () => []);
  for (const p of points) {
    const i = Math.min(buckets - 1, Math.floor(((p.ts - first) / span) * buckets));
    cells[i].push(p.pct);
  }
  let lastVal = points[0].pct;
  let out = "";
  for (const cell of cells) {
    if (cell.length > 0) lastVal = cell.reduce((s, v) => s + v, 0) / cell.length;
    out += SPARK_CHARS[Math.min(7, Math.floor((lastVal / 100) * 8))];
  }
  return out;
}

function fmtReset(epochMs: number | null): string {
  if (epochMs === null) return "?";
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** Time only (no date) — for the near-term exhaustion ETA within a window. */
function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit",
  });
}

/**
 * Urgency for the glance slot: the window whose reset is nearest, weighted
 * toward fuller windows (running out of quota soon matters most).
 */
function urgency(w: LatestWindow, nowMs: number): number {
  if (w.pct === null) return -1;
  const remainMs = w.resetEpochMs === null ? Infinity : w.resetEpochMs - nowMs;
  const remainH = Math.max(0.1, remainMs / 3600000);
  return w.pct / remainH;
}

/** Render SwiftBar plugin output. Reads latest.json + sqlite history only. */
export function renderMenubar(nowMs: number = Date.now()): string {
  if (!existsSync(LATEST_JSON_PATH)) {
    return "CQ —\n---\nquota-tracker: no data yet (run the poller)";
  }
  const latest = JSON.parse(readFileSync(LATEST_JSON_PATH, "utf8")) as {
    generatedAtMs: number;
    providers: Record<string, { windows: LatestWindow[] }>;
  };
  const windows = latest.providers["claude"]?.windows ?? [];
  if (windows.length === 0) {
    return "CQ ?\n---\nquota-tracker: latest.json has no windows";
  }

  const top = [...windows].sort((a, b) => urgency(b, nowMs) - urgency(a, nowMs))[0];
  const lines: string[] = [];
  lines.push(`CQ ${GLANCE_LABEL[top.windowKey]} ${top.pct ?? "?"}%`);
  lines.push("---");

  const store = new Store(DB_PATH);
  try {
    for (const w of windows) {
      const dur = WINDOW_DURATION_MS[w.windowKey];
      const history = store.history("claude", w.windowKey, nowMs - dur);
      const pct = w.pct === null ? "?" : `${w.pct}%`;
      // Always pair the forecast with the actual reset time so "100% by 2:39"
      // reads against "resets 3:59".
      const resetStr = w.resetEpochMs === null ? "?" : fmtReset(w.resetEpochMs);
      let fc = ` · resets ${resetStr}`;
      if (w.forecast && w.pct !== null && w.resetEpochMs !== null) {
        const eta = exhaustionEpochMs({
          nowMs,
          currentPct: w.pct,
          burnRatePctPerHour: w.forecast.burnRatePctPerHour,
          resetEpochMs: w.resetEpochMs,
        });
        // >100% is meaningless on screen — show when the cap is hit instead.
        fc = eta !== null
          ? ` → 100% by ${fmtTime(eta)} · resets ${resetStr}`
          : ` → ~${Math.round(Math.min(100, w.forecast.predictedPctAtReset))}% by reset ${resetStr}`;
      }
      lines.push(`${FULL_LABEL[w.windowKey]}: ${pct}${fc} | font=Menlo`);
      lines.push(`-- ${sparkline(history)} | font=Menlo`);
    }
  } finally {
    store.close();
  }

  const ageMin = Math.round((nowMs - latest.generatedAtMs) / 60000);
  lines.push("---");
  // In the baked binary process.execPath IS the quota binary; in dev it's node
  // (the menubar only runs from the binary, so this resolves correctly there).
  const bin = isSea() ? process.execPath : join(homedir(), ".local", "bin", "quota");
  lines.push(
    `Open Dashboard | bash="${bin}" param1=dashboard param2=--open terminal=false refresh=false`,
  );
  lines.push(`updated ${ageMin}m ago | color=#8a909a`);
  return lines.join("\n");
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  console.log(renderMenubar());
}
