import { DatabaseSync } from "node:sqlite";
import {
  SIZE_ESTIMATES,
  type RunActuals, type Task, type TaskInput, type TaskSize, type TaskStatus,
  type WindowKey, type WindowReading,
} from "./types.js";

export interface HistoryPoint {
  ts: number;
  pct: number;
  resetEpochMs: number | null;
}

export interface StoredReading extends WindowReading {
  ts: number;
  provider: string;
}

/**
 * Normalized snapshot store. One snapshots row per poll per provider, one
 * window_readings row per window observed in that poll.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Three writers share this DB (poller, executor, enqueue). WAL only gives
    // reader-writer concurrency; without a busy timeout a writer collision
    // throws SQLITE_BUSY immediately.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        PRIMARY KEY (ts, provider)
      );
      CREATE TABLE IF NOT EXISTS window_readings (
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        window_key TEXT NOT NULL,
        pct REAL,
        reset INTEGER,
        raw TEXT NOT NULL,
        PRIMARY KEY (ts, provider, window_key)
      );
      CREATE INDEX IF NOT EXISTS idx_readings_window
        ON window_readings (provider, window_key, ts);
      CREATE TABLE IF NOT EXISTS tasks (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        created_ts         INTEGER NOT NULL,
        updated_ts         INTEGER NOT NULL,
        prompt             TEXT    NOT NULL,
        cwd                TEXT    NOT NULL,
        size               TEXT    NOT NULL CHECK (size IN ('xs','s','m','l','xl')),
        priority           INTEGER NOT NULL DEFAULT 0,
        defer_ok           INTEGER NOT NULL DEFAULT 1,
        permission_class   TEXT    NOT NULL CHECK (permission_class IN ('read-only','write-scoped','destructive')),
        permission_mode    TEXT    NOT NULL,
        unattended_ok      INTEGER NOT NULL,
        scheduled_window   TEXT    NOT NULL DEFAULT 'night' CHECK (scheduled_window IN ('night','any')),
        status             TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','carried_over')),
        attempts           INTEGER NOT NULL DEFAULT 0,
        resume_session_id  TEXT,
        worktree_path      TEXT,
        last_error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_claim
        ON tasks (status, unattended_ok, priority DESC, created_ts);
      CREATE TABLE IF NOT EXISTS task_runs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id                INTEGER NOT NULL REFERENCES tasks(id),
        started_ts             INTEGER NOT NULL,
        ended_ts               INTEGER,
        pid                    INTEGER,
        size_at_run            TEXT,
        session_pct_before     REAL,
        weekly_pct_before      REAL,
        model                  TEXT,
        session_id             TEXT,
        input_tokens           INTEGER,
        output_tokens          INTEGER,
        cache_creation_tokens  INTEGER,
        cache_read_tokens      INTEGER,
        total_cost_usd         REAL,
        duration_ms            INTEGER,
        result                 TEXT,
        error                  TEXT,
        raw_json               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs (task_id, started_ts);
      CREATE INDEX IF NOT EXISTS idx_task_runs_ended
        ON task_runs (started_ts) WHERE ended_ts IS NOT NULL;
    `);
  }

  appendSnapshot(ts: number, provider: string, readings: WindowReading[]): void {
    const insSnap = this.db.prepare(
      "INSERT OR REPLACE INTO snapshots (ts, provider) VALUES (?, ?)",
    );
    const insReading = this.db.prepare(
      `INSERT OR REPLACE INTO window_readings
       (ts, provider, window_key, pct, reset, raw) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      insSnap.run(ts, provider);
      for (const r of readings) {
        insReading.run(ts, provider, r.windowKey, r.pct, r.resetEpochMs, r.raw);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Parsed readings for one window since a timestamp, oldest first. */
  history(provider: string, windowKey: WindowKey, sinceTs: number): HistoryPoint[] {
    const rows = this.db
      .prepare(
        `SELECT ts, pct, reset FROM window_readings
         WHERE provider = ? AND window_key = ? AND ts >= ? AND pct IS NOT NULL
         ORDER BY ts ASC`,
      )
      .all(provider, windowKey, sinceTs) as Array<{
        ts: number; pct: number; reset: number | null;
      }>;
    return rows.map((r) => ({ ts: r.ts, pct: r.pct, resetEpochMs: r.reset }));
  }

  /** Most recent reading per window for a provider. */
  latest(provider: string): StoredReading[] {
    const rows = this.db
      .prepare(
        `SELECT ts, provider, window_key, pct, reset, raw FROM window_readings
         WHERE provider = ? AND ts = (SELECT MAX(ts) FROM snapshots WHERE provider = ?)`,
      )
      .all(provider, provider) as Array<{
        ts: number; provider: string; window_key: string;
        pct: number | null; reset: number | null; raw: string;
      }>;
    return rows.map((r) => ({
      ts: r.ts,
      provider: r.provider,
      windowKey: r.window_key as WindowKey,
      pct: r.pct,
      resetEpochMs: r.reset,
      raw: r.raw,
    }));
  }

  // ---- Part B: task queue ----

  private rowToTask(r: Record<string, unknown>): Task {
    return {
      id: r.id as number,
      createdTs: r.created_ts as number,
      updatedTs: r.updated_ts as number,
      prompt: r.prompt as string,
      cwd: r.cwd as string,
      size: r.size as TaskSize,
      priority: r.priority as number,
      deferOk: r.defer_ok === 1,
      permissionClass: r.permission_class as Task["permissionClass"],
      permissionMode: r.permission_mode as string,
      unattendedOk: r.unattended_ok === 1,
      scheduledWindow: r.scheduled_window as Task["scheduledWindow"],
      status: r.status as TaskStatus,
      attempts: r.attempts as number,
      resumeSessionId: (r.resume_session_id as string) ?? null,
      worktreePath: (r.worktree_path as string) ?? null,
      lastError: (r.last_error as string) ?? null,
    };
  }

  enqueueTask(ts: number, input: TaskInput): Task {
    const row = this.db
      .prepare(
        `INSERT INTO tasks
         (created_ts, updated_ts, prompt, cwd, size, priority, defer_ok,
          permission_class, permission_mode, unattended_ok, scheduled_window)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        ts, ts, input.prompt, input.cwd, input.size, input.priority,
        input.deferOk ? 1 : 0, input.permissionClass, input.permissionMode,
        input.unattendedOk ? 1 : 0, input.scheduledWindow,
      ) as Record<string, unknown>;
    return this.rowToTask(row);
  }

  getTask(id: number): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(statuses?: TaskStatus[]): Task[] {
    const rows = (
      statuses && statuses.length > 0
        ? this.db
            .prepare(
              `SELECT * FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")})
               ORDER BY priority DESC, created_ts ASC`,
            )
            .all(...statuses)
        : this.db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_ts ASC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToTask(r));
  }

  /** True if any unattended task is waiting for the night executor. */
  hasClaimableTask(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM tasks
         WHERE status IN ('queued','carried_over') AND unattended_ok = 1 LIMIT 1`,
      )
      .get();
    return row !== undefined;
  }

  /** Next claimable task without claiming it (window-fit check before claim). */
  peekNextTask(): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('queued','carried_over') AND unattended_ok = 1
         ORDER BY priority DESC, created_ts ASC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * Atomically claim the highest-priority unattended task: single UPDATE with
   * a subselect so two executors can never claim the same task.
   */
  claimNextTask(ts: number): Task | null {
    const row = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', updated_ts = ?, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM tasks
           WHERE status IN ('queued','carried_over') AND unattended_ok = 1
           ORDER BY priority DESC, created_ts ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get(ts) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /** Claim one specific task for a manual (attended) run. */
  claimTaskById(ts: number, id: number): Task | null {
    const row = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', updated_ts = ?, attempts = attempts + 1
         WHERE id = ? AND status IN ('queued','carried_over','failed')
         RETURNING *`,
      )
      .get(ts, id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : null;
  }

  startRun(args: {
    ts: number;
    taskId: number;
    pid: number | null;
    sizeAtRun: TaskSize;
    sessionPctBefore: number | null;
    weeklyPctBefore: number | null;
  }): number {
    const row = this.db
      .prepare(
        `INSERT INTO task_runs
         (task_id, started_ts, pid, size_at_run, session_pct_before, weekly_pct_before)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        args.taskId, args.ts, args.pid, args.sizeAtRun,
        args.sessionPctBefore, args.weeklyPctBefore,
      ) as { id: number };
    return row.id;
  }

  finishRun(runId: number, endedTs: number, actuals: RunActuals): void {
    this.db
      .prepare(
        `UPDATE task_runs SET ended_ts = ?, model = ?, session_id = ?,
           input_tokens = ?, output_tokens = ?, cache_creation_tokens = ?,
           cache_read_tokens = ?, total_cost_usd = ?, duration_ms = ?,
           result = ?, error = ?, raw_json = ?
         WHERE id = ?`,
      )
      .run(
        endedTs, actuals.model, actuals.sessionId, actuals.inputTokens,
        actuals.outputTokens, actuals.cacheCreationTokens, actuals.cacheReadTokens,
        actuals.totalCostUsd, actuals.durationMs, actuals.result, actuals.error,
        actuals.rawJson, runId,
      );
  }

  /** Terminal/retry transition after a run. */
  settleTask(args: {
    ts: number;
    taskId: number;
    status: Extract<TaskStatus, "done" | "failed" | "carried_over">;
    resumeSessionId?: string | null;
    worktreePath?: string | null;
    lastError?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, updated_ts = ?,
           resume_session_id = COALESCE(?, resume_session_id),
           worktree_path = COALESCE(?, worktree_path),
           last_error = ?
         WHERE id = ?`,
      )
      .run(
        args.status, args.ts, args.resumeSessionId ?? null,
        args.worktreePath ?? null, args.lastError ?? null, args.taskId,
      );
  }

  /** Latest run row (for stale-pid recovery). */
  latestRunForTask(taskId: number): {
    id: number; pid: number | null; startedTs: number; endedTs: number | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, pid, started_ts, ended_ts FROM task_runs WHERE task_id = ?
         ORDER BY started_ts DESC LIMIT 1`,
      )
      .get(taskId) as {
        id: number; pid: number | null; started_ts: number; ended_ts: number | null;
      } | undefined;
    return row
      ? { id: row.id, pid: row.pid, startedTs: row.started_ts, endedTs: row.ended_ts }
      : null;
  }

  /** estimate vs actual joined view — the DoD "조회 가능" query. */
  estimationRecords(): Array<{
    taskId: number;
    size: TaskSize;
    estimateTokens: number | null;
    actualTokens: number | null;
    model: string | null;
    durationMs: number | null;
    result: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.task_id AS taskId, r.size_at_run AS size,
                r.input_tokens + r.output_tokens +
                COALESCE(r.cache_creation_tokens,0) AS actualTokens,
                r.model, r.duration_ms AS durationMs, r.result
         FROM task_runs r WHERE r.ended_ts IS NOT NULL
         ORDER BY r.started_ts ASC`,
      )
      .all() as Array<{
        taskId: number; size: TaskSize; actualTokens: number | null;
        model: string | null; durationMs: number | null; result: string | null;
      }>;
    return rows.map((r) => ({
      ...r,
      estimateTokens: r.size ? SIZE_ESTIMATES[r.size]?.tokens ?? null : null,
    }));
  }

  // ---- Part C: dashboard aggregations (read-only) ----

  /** Per-model token-category sums + cost + run count over a window. */
  modelTotals(fromTs: number, toTs: number): Array<{
    model: string; inputTokens: number; outputTokens: number;
    cacheCreationTokens: number; cacheReadTokens: number;
    totalCostUsd: number; runs: number; totalTokens: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(model,'(unknown)') AS model,
                SUM(COALESCE(input_tokens,0)) AS input,
                SUM(COALESCE(output_tokens,0)) AS output,
                SUM(COALESCE(cache_creation_tokens,0)) AS cacheCreate,
                SUM(COALESCE(cache_read_tokens,0)) AS cacheRead,
                SUM(COALESCE(total_cost_usd,0)) AS cost,
                COUNT(*) AS runs
         FROM task_runs
         WHERE ended_ts IS NOT NULL AND started_ts BETWEEN ? AND ?
         GROUP BY model ORDER BY cost DESC`,
      )
      .all(fromTs, toTs) as Array<{
        model: string; input: number; output: number; cacheCreate: number;
        cacheRead: number; cost: number; runs: number;
      }>;
    return rows.map((r) => ({
      model: r.model,
      inputTokens: r.input,
      outputTokens: r.output,
      cacheCreationTokens: r.cacheCreate,
      cacheReadTokens: r.cacheRead,
      totalCostUsd: r.cost,
      runs: r.runs,
      // Include all four categories so the model-row total reconciles with the
      // input/output/cache-create/cache-read breakdown bar.
      totalTokens: r.input + r.output + r.cacheCreate + r.cacheRead,
    }));
  }

  /** Single-row token-category split for the 100% stacked bar. */
  tokenCategoryTotals(fromTs: number, toTs: number): {
    input: number; output: number; cacheCreation: number; cacheRead: number;
  } {
    const r = this.db
      .prepare(
        `SELECT SUM(COALESCE(input_tokens,0)) AS input,
                SUM(COALESCE(output_tokens,0)) AS output,
                SUM(COALESCE(cache_creation_tokens,0)) AS cacheCreate,
                SUM(COALESCE(cache_read_tokens,0)) AS cacheRead
         FROM task_runs
         WHERE ended_ts IS NOT NULL AND started_ts BETWEEN ? AND ?`,
      )
      .get(fromTs, toTs) as {
        input: number | null; output: number | null;
        cacheCreate: number | null; cacheRead: number | null;
      };
    return {
      input: r.input ?? 0, output: r.output ?? 0,
      cacheCreation: r.cacheCreate ?? 0, cacheRead: r.cacheRead ?? 0,
    };
  }

  /** Lightweight per-run projection — server buckets these by local day/hour. */
  runsInRange(fromTs: number, toTs: number): Array<{
    startedTs: number; model: string; totalTokens: number; costUsd: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT started_ts AS ts, COALESCE(model,'(unknown)') AS model,
                COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
                  + COALESCE(cache_creation_tokens,0)
                  + COALESCE(cache_read_tokens,0) AS tokens,
                COALESCE(total_cost_usd,0) AS cost
         FROM task_runs
         WHERE ended_ts IS NOT NULL AND started_ts BETWEEN ? AND ?
         ORDER BY started_ts ASC`,
      )
      .all(fromTs, toTs) as Array<{ ts: number; model: string; tokens: number; cost: number }>;
    return rows.map((r) => ({
      startedTs: r.ts, model: r.model, totalTokens: r.tokens, costUsd: r.cost,
    }));
  }

  /** Header KPI totals. */
  runCostSummary(fromTs: number, toTs: number): {
    totalCostUsd: number; totalTokens: number; runs: number;
  } {
    const r = this.db
      .prepare(
        `SELECT SUM(COALESCE(total_cost_usd,0)) AS cost,
                SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)
                    +COALESCE(cache_creation_tokens,0)
                    +COALESCE(cache_read_tokens,0)) AS tokens,
                COUNT(*) AS runs
         FROM task_runs
         WHERE ended_ts IS NOT NULL AND started_ts BETWEEN ? AND ?`,
      )
      .get(fromTs, toTs) as { cost: number | null; tokens: number | null; runs: number };
    return { totalCostUsd: r.cost ?? 0, totalTokens: r.tokens ?? 0, runs: r.runs };
  }

  /** Task queue status counts. */
  queueCounts(): Record<TaskStatus, number> {
    const base: Record<TaskStatus, number> = {
      queued: 0, running: 0, done: 0, failed: 0, carried_over: 0,
    };
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
      .all() as Array<{ status: TaskStatus; n: number }>;
    for (const r of rows) base[r.status] = r.n;
    return base;
  }

  close(): void {
    this.db.close();
  }
}
