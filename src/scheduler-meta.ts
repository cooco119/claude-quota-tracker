import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";

export type SchedulingIntent = "interactive" | "deadline" | "opportunistic";

export interface TaskScheduleMeta {
  taskId: number;
  intent: SchedulingIntent;
  deadlineMs: number | null;
  estimatedTokens: number | null;
  paused: boolean;
  continuousOk: boolean;
  createdTs: number;
  updatedTs: number;
}

export interface TaskScheduleMetaInput {
  intent?: SchedulingIntent;
  deadlineMs?: number | null;
  estimatedTokens?: number | null;
  paused?: boolean;
  continuousOk?: boolean;
}

export class SchedulerMetaStore {
  private db: DatabaseSync;

  constructor(path: string = DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_schedule_meta (
        task_id           INTEGER PRIMARY KEY REFERENCES tasks(id),
        intent            TEXT NOT NULL DEFAULT 'opportunistic'
                          CHECK (intent IN ('interactive','deadline','opportunistic')),
        deadline_ms       INTEGER,
        estimated_tokens  INTEGER,
        paused            INTEGER NOT NULL DEFAULT 0,
        continuous_ok     INTEGER NOT NULL DEFAULT 0,
        created_ts        INTEGER NOT NULL,
        updated_ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_schedule_deadline
        ON task_schedule_meta (paused, intent, deadline_ms);
    `);
  }

  private row(r: Record<string, unknown>): TaskScheduleMeta {
    return {
      taskId: r.task_id as number,
      intent: r.intent as SchedulingIntent,
      deadlineMs: (r.deadline_ms as number | null) ?? null,
      estimatedTokens: (r.estimated_tokens as number | null) ?? null,
      paused: r.paused === 1,
      continuousOk: r.continuous_ok === 1,
      createdTs: r.created_ts as number,
      updatedTs: r.updated_ts as number,
    };
  }

  get(taskId: number): TaskScheduleMeta | null {
    const r = this.db.prepare("SELECT * FROM task_schedule_meta WHERE task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  getOrDefault(taskId: number): TaskScheduleMeta {
    return this.get(taskId) ?? {
      taskId,
      intent: "opportunistic",
      deadlineMs: null,
      estimatedTokens: null,
      paused: false,
      continuousOk: false,
      createdTs: 0,
      updatedTs: 0,
    };
  }

  upsert(taskId: number, nowMs: number, input: TaskScheduleMetaInput): TaskScheduleMeta {
    const intent = input.intent ?? "opportunistic";
    if (intent === "deadline" && input.deadlineMs == null) {
      throw new Error("deadline intent requires deadlineMs");
    }
    const r = this.db.prepare(`
      INSERT INTO task_schedule_meta
        (task_id, intent, deadline_ms, estimated_tokens, paused, continuous_ok, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        intent=excluded.intent,
        deadline_ms=excluded.deadline_ms,
        estimated_tokens=excluded.estimated_tokens,
        paused=excluded.paused,
        continuous_ok=excluded.continuous_ok,
        updated_ts=excluded.updated_ts
      RETURNING *
    `).get(
      taskId, intent, input.deadlineMs ?? null, input.estimatedTokens ?? null,
      input.paused ? 1 : 0, input.continuousOk ? 1 : 0, nowMs, nowMs,
    ) as Record<string, unknown>;
    return this.row(r);
  }

  setPaused(taskId: number, paused: boolean, nowMs: number): TaskScheduleMeta {
    const current = this.getOrDefault(taskId);
    return this.upsert(taskId, nowMs, { ...current, paused });
  }

  list(): TaskScheduleMeta[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_schedule_meta ORDER BY updated_ts DESC",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.row(r));
  }

  close(): void { this.db.close(); }
}
