import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, saveConfigPatch } from "../src/config.js";

const dirs: string[] = [];
function tmpConfig(content?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "qt-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (content !== undefined) writeFileSync(path, JSON.stringify(content));
  return path;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadConfig (Part B fields)", () => {
  it("returns defaults when the file is missing", () => {
    const c = loadConfig("/nonexistent/config.json");
    expect(c.nightWindow.confirmedAt).toBeNull();
    expect(c.executor.enabled).toBe(true);
  });

  it("derives nightWindow start/end from quietHours when absent (old Part A config)", () => {
    const path = tmpConfig({
      pollIntervalSeconds: 300,
      notify: { quietHours: { start: "22:30", end: "07:00" } },
    });
    const c = loadConfig(path);
    expect(c.nightWindow.start).toBe("22:30");
    expect(c.nightWindow.end).toBe("07:00");
    expect(c.nightWindow.confirmedAt).toBeNull();
  });

  it("explicit nightWindow wins over the quietHours derivation", () => {
    const path = tmpConfig({
      notify: { quietHours: { start: "22:30", end: "07:00" } },
      nightWindow: { start: "00:30", end: "06:00", confirmedAt: "x", confirmedTz: "Asia/Seoul" },
    });
    const c = loadConfig(path);
    expect(c.nightWindow.start).toBe("00:30");
    expect(c.nightWindow.confirmedAt).toBe("x");
  });

  it("deep-merges a partial taskTimeoutMinutes override (no NaN timeouts)", () => {
    const path = tmpConfig({ executor: { taskTimeoutMinutes: { xl: 90 } } });
    const c = loadConfig(path);
    expect(c.executor.taskTimeoutMinutes.xl).toBe(90);
    expect(c.executor.taskTimeoutMinutes.xs).toBe(
      DEFAULT_CONFIG.executor.taskTimeoutMinutes.xs,
    );
  });
});

describe("saveConfigPatch", () => {
  it("round-trips a night window confirmation through loadConfig", () => {
    const path = tmpConfig({ pollIntervalSeconds: 300 });
    saveConfigPatch(
      {
        nightWindow: {
          start: "23:00", end: "08:00",
          confirmedAt: "2026-06-11T12:00:00.000Z", confirmedTz: "Asia/Seoul",
        },
      },
      path,
    );
    const c = loadConfig(path);
    expect(c.nightWindow.confirmedAt).toBe("2026-06-11T12:00:00.000Z");
    expect(c.nightWindow.confirmedTz).toBe("Asia/Seoul");
  });

  it("preserves unknown user keys it does not manage", () => {
    const path = tmpConfig({ myCustomKey: { keep: true }, pollIntervalSeconds: 60 });
    saveConfigPatch({ executor: { enabled: false } }, path);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.myCustomKey).toEqual({ keep: true });
    expect(raw.pollIntervalSeconds).toBe(60);
    expect(raw.executor.enabled).toBe(false);
  });
});
