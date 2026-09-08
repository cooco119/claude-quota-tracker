import { loadConfig } from "./config.js";
import { pollOnce } from "./poller.js";

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Portable scheduler loop for environments without launchd/systemd (containers,
 * Distrobox, minimal Linux sessions). Polling remains one-shot in pollOnce();
 * this process only supplies the repeating clock.
 */
export async function runDaemon(): Promise<void> {
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[quota-tracker] portable daemon started (pid ${process.pid})`);
  while (!stopping) {
    const started = Date.now();
    try {
      await pollOnce(started);
    } catch (e) {
      console.error("[quota-tracker] daemon poll failed:", e);
    }
    const intervalMs = Math.max(10, loadConfig().pollIntervalSeconds) * 1000;
    const remaining = Math.max(0, intervalMs - (Date.now() - started));
    if (!stopping) await sleep(remaining);
  }
  console.log("[quota-tracker] portable daemon stopped");
}
