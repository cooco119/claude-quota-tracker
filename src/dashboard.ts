import { execFile, spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR, DB_PATH, loadConfig } from "./config.js";
import * as api from "./dashboard-api.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";
import { isSea } from "./sea.js";
import { Store } from "./store.js";

const LOCK_PATH = join(DATA_DIR, "dashboard.lock");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Lock { pid: number; port: number; startedAtMs: number; token: string }

function readLock(): Lock | null {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Lock;
  } catch {
    return null;
  }
}

function writeLock(lock: Lock): void {
  const tmp = `${LOCK_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock));
  renameSync(tmp, LOCK_PATH);
}

/** GET /healthz against a port; resolves the lock if it answers as ours. */
function probeHealthz(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(
      { host: "127.0.0.1", port, path: "/healthz", timeout: 400 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(j.ok === true && j.token === token);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** Returns the live port if a healthy server already owns the lock. */
async function probeAlive(): Promise<number | null> {
  const lock = readLock();
  if (!lock) return null;
  return (await probeHealthz(lock.port, lock.token)) ? lock.port : null;
}

function openBrowser(port: number): void {
  execFile("open", [`http://127.0.0.1:${port}/`], () => {});
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(s);
}

function handleApi(store: Store, url: URL, res: ServerResponse): void {
  const nowMs = Date.now();
  const num = (k: string, d: number) => {
    const raw = url.searchParams.get(k);
    if (raw === null || raw === "") return d; // Number(null)===0 would shadow the default
    const v = Number(raw);
    return Number.isFinite(v) ? v : d;
  };
  switch (url.pathname) {
    case "/api/overview": return json(res, 200, api.overview(store, nowMs));
    case "/api/models": {
      const from = num("from", nowMs - 7 * DAY_MS);
      return json(res, 200, api.models(store, from, num("to", nowMs)));
    }
    case "/api/contrib": {
      const from = num("from", nowMs - 84 * DAY_MS); // ~12 weeks
      return json(res, 200, api.contrib(store, from, num("to", nowMs)));
    }
    case "/api/timeseries": return json(res, 200, api.timeseries(store, nowMs));
    case "/api/estimates": return json(res, 200, api.estimates(store));
    case "/api/queue": return json(res, 200, api.queue(store));
    default: return json(res, 404, { error: "not found" });
  }
}

/** Reject non-localhost Host headers (defeats DNS-rebinding to 127.0.0.1). */
function hostIsLocal(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function startServer(port: number, token: string): void {
  const cfg = loadConfig();
  mkdirSync(DATA_DIR, { recursive: true });
  const startedAtMs = Date.now();
  let lastReqMs = startedAtMs;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastReqMs = Date.now();
    if (!hostIsLocal(req)) return json(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, pid: process.pid, token, startedAtMs });
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(DASHBOARD_HTML);
    }
    if (url.pathname.startsWith("/api/")) {
      // Each request opens/closes the store (WAL reader, safe alongside writers).
      const store = new Store(DB_PATH);
      try {
        handleApi(store, url, res);
      } catch (e) {
        json(res, 500, { error: String(e) });
      } finally {
        store.close();
      }
      return;
    }
    json(res, 404, { error: "not found" });
  });

  const tryListen = (p: number, attempt: number): void => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && attempt < 5) return tryListen(p + 1, attempt + 1);
      console.error("[dashboard] listen failed:", e);
      process.exit(1);
    });
    server.listen(p, "127.0.0.1", () => {
      writeLock({ pid: process.pid, port: p, startedAtMs: Date.now(), token });
      console.log(`[dashboard] http://127.0.0.1:${p}/`);
      // The browser is opened by the launcher (launch()), never here — opening
      // in both the spawned server and the launcher pops two tabs on cold start.
    });
  };
  tryListen(port, 0);

  const cleanup = () => {
    const lock = readLock();
    if (lock && lock.pid === process.pid) { try { unlinkSync(LOCK_PATH); } catch { /* gone */ } }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  if (cfg.dashboard.idleShutdownMin > 0) {
    const idleMs = cfg.dashboard.idleShutdownMin * 60 * 1000;
    setInterval(() => {
      if (Date.now() - lastReqMs > idleMs) {
        console.log("[dashboard] idle shutdown");
        cleanup();
        process.exit(0);
      }
    }, 30_000).unref();
  }
}

/**
 * Launcher path (no --foreground): idempotently ensure a server is up, then
 * open the browser. Re-invokes itself detached as the actual server.
 */
const LAUNCH_LOCK = join(DATA_DIR, "dashboard.launching");

/** Wait up to ~3s for a healthy server to appear, then open the browser. */
async function waitAndOpen(open: boolean): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const port = await probeAlive();
    if (port !== null) { if (open) openBrowser(port); return true; }
  }
  return false;
}

async function launch(open: boolean): Promise<void> {
  const alive = await probeAlive();
  if (alive !== null) {
    if (open) openBrowser(alive);
    return;
  }
  mkdirSync(DATA_DIR, { recursive: true });

  // Elect a single spawner: concurrent launchers (e.g. two SwiftBar clicks
  // during a cold start) must not each spawn a server and orphan one via the
  // EADDRINUSE port-walk. Losers just wait for the winner's server.
  try {
    writeFileSync(LAUNCH_LOCK, String(process.pid), { flag: "wx" });
  } catch {
    if (await waitAndOpen(open)) return;
    // Winner died mid-launch — steal the stale lock and spawn ourselves.
    try { unlinkSync(LAUNCH_LOCK); } catch { /* already gone */ }
    try { writeFileSync(LAUNCH_LOCK, String(process.pid), { flag: "wx" }); }
    catch { return; } // another launcher beat us to the retry
  }

  try {
    const args = isSea()
      ? ["dashboard", "--foreground"]
      : [join(dirname(fileURLToPath(import.meta.url)), "dashboard.js"), "--foreground"];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", (e) => console.error("[dashboard] spawn failed:", e));
    child.unref();
    if (!(await waitAndOpen(open))) {
      console.error("[dashboard] server did not come up in time");
      process.exitCode = 1;
    }
  } finally {
    try { unlinkSync(LAUNCH_LOCK); } catch { /* already gone */ }
  }
}

export async function dashboard(argv: string[]): Promise<void> {
  if (argv.includes("--foreground")) {
    const cfg = loadConfig();
    const token = `${process.pid}-${Date.now()}`;
    startServer(cfg.dashboard.port, token);
    return; // server keeps the event loop alive
  }
  await launch(argv.includes("--open"));
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  dashboard(process.argv.slice(2)).catch((e) => {
    console.error("[dashboard] fatal:", e);
    process.exitCode = 1;
  });
}
