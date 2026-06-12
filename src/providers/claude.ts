import { execFile } from "node:child_process";
import { parseUsageOutput } from "../parser.js";
import type { UsageProvider, WindowReading } from "../types.js";

/**
 * Runs `claude -p "/usage"` and parses the three usage windows.
 * Measured 2026-06-11: the call itself does not consume usage (3 calls in
 * ~1 min, all percentages unchanged), so a 5-minute poll cadence is safe.
 */
export class ClaudeProvider implements UsageProvider {
  id = "claude";

  constructor(private claudeBin: string = "claude") {}

  fetch(): Promise<WindowReading[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.claudeBin,
        ["-p", "/usage"],
        { timeout: 60_000 },
        (err, stdout) => {
          if (err) return reject(new Error(`claude /usage failed: ${err.message}`));
          resolve(parseUsageOutput(stdout, Date.now()));
        },
      );
    });
  }
}
