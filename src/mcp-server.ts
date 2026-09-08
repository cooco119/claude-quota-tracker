import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { DATA_DIR, DB_PATH, loadConfig } from "./config.js";
import { runManualTask } from "./executor.js";
import { loadPacingConfig } from "./pacing-config.js";
import { quotaPacingVerdict } from "./pacing.js";
import { readQuotaSnapshot } from "./quota-state.js";
import { SchedulerMetaStore, type SchedulingIntent } from "./scheduler-meta.js";
import { Store } from "./store.js";
import { TRIAGE, windowGuard } from "./tasks.js";
import type { PermissionClass, TaskSize } from "./types.js";

const SIZES = new Set<TaskSize>(["xs", "s", "m", "l", "xl"]);
const PERMS = new Set<PermissionClass>(["read-only", "write-scoped", "destructive"]);
const INTENTS = new Set<SchedulingIntent>(["interactive", "deadline", "opportunistic"]);

type Json = Record<string, unknown>;

function text(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function deadlineMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("deadline must be an ISO-8601 date/time or epoch milliseconds");
}

const toolSchemas = [
  {
    name: "submit_task",
    description: "Queue Claude Code work for quota-aware execution. Use opportunistic for deferrable work, deadline for work that must finish by a time, interactive for manual-only work.",
    inputSchema: {
      type: "object",
      required: ["prompt", "cwd"],
      properties: {
        prompt: { type: "string" }, cwd: { type: "string" },
        size: { type: "string", enum: ["xs", "s", "m", "l", "xl"], default: "m" },
        priority: { type: "number", default: 0 },
        intent: { type: "string", enum: ["interactive", "deadline", "opportunistic"], default: "opportunistic" },
        deadline: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        estimated_tokens: { type: "number" },
        permission: { type: "string", enum: ["read-only", "write-scoped", "destructive"], default: "read-only" },
        continuous: { type: "boolean", default: false, description: "Explicitly opt this task into unattended execution outside the confirmed night window." },
      },
    },
  },
  { name: "get_quota_status", description: "Return current Claude 5-hour and weekly quota readings and hard-guard status.", inputSchema: { type: "object", properties: {} } },
  { name: "get_pacing_status", description: "Return quota pacing targets and whether opportunistic work may run now.", inputSchema: { type: "object", properties: {} } },
  { name: "list_tasks", description: "List queued/running/completed tasks with scheduling metadata.", inputSchema: { type: "object", properties: {} } },
  { name: "pause_task", description: "Pause scheduler admission for one task.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } } },
  { name: "resume_task", description: "Resume scheduler admission for one task.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } } },
  { name: "run_now", description: "Manually run one queued task now. Hard quota guards and Claude permission rules still apply; pacing is bypassed.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "number" } } } },
];

async function callTool(name: string, args: Json): Promise<unknown> {
  mkdirSync(DATA_DIR, { recursive: true });
  const config = loadConfig();
  const pacingCfg = loadPacingConfig();

  if (name === "get_quota_status" || name === "get_pacing_status") {
    const nowMs = Date.now();
    const snapshot = readQuotaSnapshot(nowMs);
    const hard = windowGuard(snapshot.guard, config.executor);
    if (name === "get_quota_status") return text({ generatedAtMs: snapshot.generatedAtMs, ...snapshot.guard, hardGuard: hard });
    const pacing = quotaPacingVerdict({
      enabled: pacingCfg.enabled, nowMs,
      sessionPct: snapshot.guard.sessionPct, sessionResetMs: snapshot.guard.sessionResetMs,
      weeklyPct: snapshot.guard.weeklyPct, weeklyResetMs: snapshot.guard.weeklyResetMs,
      sessionBudgetPct: config.executor.sessionGuardPct,
      weeklyBudgetPct: config.executor.weeklyGuardPct,
      slackPct: pacingCfg.slackPct,
      sessionWindowMs: pacingCfg.sessionWindowHours * 3_600_000,
      weeklyWindowMs: pacingCfg.weeklyWindowHours * 3_600_000,
    });
    return text({ pacing, config: pacingCfg });
  }

  const store = new Store(DB_PATH);
  const meta = new SchedulerMetaStore(DB_PATH);
  try {
    if (name === "submit_task") {
      const prompt = str(args.prompt).trim();
      const cwd = str(args.cwd).trim();
      if (!prompt || !cwd) throw new Error("prompt and cwd are required");
      const size = str(args.size, "m") as TaskSize;
      const permission = str(args.permission, "read-only") as PermissionClass;
      const intent = str(args.intent, "opportunistic") as SchedulingIntent;
      if (!SIZES.has(size)) throw new Error("invalid size");
      if (!PERMS.has(permission)) throw new Error("invalid permission");
      if (!INTENTS.has(intent)) throw new Error("invalid intent");
      const deadline = deadlineMs(args.deadline);
      if (intent === "deadline" && deadline === null) throw new Error("deadline intent requires deadline");
      if (deadline !== null && deadline <= Date.now()) throw new Error("deadline must be in the future");
      const rule = TRIAGE[permission];
      const requestedContinuous = bool(args.continuous, false);
      const continuous = requestedContinuous && rule.unattendedOk && intent !== "interactive";
      const task = store.enqueueTask(Date.now(), {
        prompt, cwd, size, priority: num(args.priority, 0),
        deferOk: intent !== "interactive",
        permissionClass: permission, permissionMode: rule.permissionMode,
        unattendedOk: rule.unattendedOk,
        scheduledWindow: continuous ? "any" : "night",
      });
      const m = meta.upsert(task.id, Date.now(), {
        intent, deadlineMs: deadline,
        estimatedTokens: args.estimated_tokens == null ? null : num(args.estimated_tokens, 0),
        paused: false, continuousOk: continuous,
      });
      return text({ task, scheduling: m, note: permission === "destructive" ? "destructive tasks are manual-only" : undefined });
    }

    if (name === "list_tasks") {
      return text(store.listTasks().map((task) => ({ task, scheduling: meta.getOrDefault(task.id) })));
    }

    const taskId = Math.trunc(num(args.task_id, NaN));
    if (!Number.isFinite(taskId)) throw new Error("task_id is required");
    if (!store.getTask(taskId)) throw new Error(`task #${taskId} not found`);
    if (name === "pause_task") return text(meta.setPaused(taskId, true, Date.now()));
    if (name === "resume_task") return text(meta.setPaused(taskId, false, Date.now()));
    if (name === "run_now") {
      meta.setPaused(taskId, false, Date.now());
      const ok = await runManualTask(taskId);
      return text({ taskId, ok });
    }
    throw new Error(`unknown tool: ${name}`);
  } finally {
    meta.close();
    store.close();
  }
}

function send(id: unknown, result?: unknown, error?: unknown): void {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }) + "\n");
}

export async function startMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: Json;
    try { req = JSON.parse(line) as Json; }
    catch { continue; }
    const id = req.id;
    const method = str(req.method);
    if (id === undefined) continue; // notification
    try {
      if (method === "initialize") {
        const params = (req.params ?? {}) as Json;
        send(id, {
          protocolVersion: str(params.protocolVersion, "2025-11-25"),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "claude-quota-tracker", version: "0.2.0" },
        });
      } else if (method === "tools/list") {
        send(id, { tools: toolSchemas });
      } else if (method === "tools/call") {
        const p = (req.params ?? {}) as Json;
        send(id, await callTool(str(p.name), ((p.arguments ?? {}) as Json)));
      } else if (method === "ping") {
        send(id, {});
      } else {
        send(id, undefined, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (e) {
      send(id, undefined, { code: -32000, message: e instanceof Error ? e.message : String(e) });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((e) => { console.error(e); process.exitCode = 1; });
}
