import { readFileSync } from "node:fs";
import { CONFIG_PATH } from "./config.js";

export interface PacingConfig {
  enabled: boolean;
  slackPct: number;
  sessionWindowHours: number;
  weeklyWindowHours: number;
}

export const DEFAULT_PACING_CONFIG: PacingConfig = {
  enabled: false,
  slackPct: 5,
  sessionWindowHours: 5,
  weeklyWindowHours: 7 * 24,
};

export function loadPacingConfig(path: string = CONFIG_PATH): PacingConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pacing?: Partial<PacingConfig> };
    return { ...DEFAULT_PACING_CONFIG, ...(raw.pacing ?? {}) };
  } catch {
    return DEFAULT_PACING_CONFIG;
  }
}
