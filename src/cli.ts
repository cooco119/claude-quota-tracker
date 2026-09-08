import { CONFIG_PATH, DATA_DIR } from "./config.js";
import { dashboard } from "./dashboard.js";
import { runDaemon } from "./daemon.js";
import { enqueue } from "./enqueue.js";
import { runManualTask, runNightLoop } from "./executor.js";
import { install, uninstall } from "./install.js";
import { renderMenubar } from "./menubar.js";
import { pollOnce } from "./poller.js";
import { printHint, printStatus, printTasks } from "./report.js";
import { runPacedOnce } from "./paced-executor.js";
import { startMcpServer } from "./mcp-server.js";

const HELP = `quota — Claude quota tracker & quota-aware task orchestrator

Usage:
  quota install            install launcher + native scheduler when available
  quota uninstall          remove native scheduler integration (data preserved)
  quota daemon             portable polling loop (no systemd/launchd required)
  quota poll               poll usage once
  quota executor           legacy night queue loop
  quota paced-executor     quota-aware admission + at most one task
  quota executor --task N  run task N manually (hard quota guards preserved)
  quota enqueue            interactive task registration
  quota mcp                start MCP stdio server
  quota status [--json]    current usage/forecast/KPI
  quota tasks [--json]     task queue state
  quota hint [--threshold N]
  quota menubar            SwiftBar output (macOS)
  quota dashboard [--open] local dashboard
  quota ingest             ingest Claude Code session logs
  quota paths              print config/data paths
`;

function checkNodeVersion(): boolean {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(`quota requires Node 22.5+ (current: ${process.versions.node})`);
    return false;
  }
  return true;
}

export async function main(argv: string[]): Promise<void> {
  if (!checkNodeVersion()) { process.exitCode = 1; return; }
  const cmd = argv[0];
  switch (cmd) {
    case "poll": {
      const latest = await pollOnce();
      const n = Object.values(latest.providers).reduce((s, p) => s + p.windows.length, 0);
      console.log(`[quota-tracker] polled ${n} window readings`);
      return;
    }
    case "daemon":
      return runDaemon();
    case "executor": {
      const taskFlag = argv.indexOf("--task");
      if (taskFlag !== -1) {
        const ok = await runManualTask(Number(argv[taskFlag + 1]));
        process.exitCode = ok ? 0 : 1;
      } else await runNightLoop();
      return;
    }
    case "paced-executor": {
      const ok = await runPacedOnce(); process.exitCode = ok ? 0 : 1; return;
    }
    case "mcp": return startMcpServer();
    case "install": return install();
    case "uninstall": return uninstall();
    case "enqueue": return enqueue(argv.slice(1));
    case "menubar": console.log(renderMenubar()); return;
    case "status": printStatus(argv.slice(1)); return;
    case "tasks": printTasks(argv.slice(1)); return;
    case "hint": printHint(argv.slice(1)); return;
    case "ingest": {
      const { ingestUsage } = await import("./ingest.js");
      const { Store } = await import("./store.js");
      const { DB_PATH } = await import("./config.js");
      const store = new Store(DB_PATH);
      try {
        const r = ingestUsage(store, Date.now());
        console.log(`[quota-tracker] ingest: ${r.inserted} new events from ${r.scanned}/${r.files} files`);
      } finally { store.close(); }
      return;
    }
    case "dashboard": return dashboard(argv.slice(1));
    case "paths": console.log(`config: ${CONFIG_PATH}`); console.log(`data:   ${DATA_DIR}`); return;
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => { console.error("[quota-tracker] fatal:", e); process.exitCode = 1; });
