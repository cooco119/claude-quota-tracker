import { execFile } from "node:child_process";
import type { RunActuals, Task } from "./types.js";

/** Injectable exec seam (default wraps execFile) — tests pass a fake. */
export type ExecFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>;

export const realExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve) => {
    execFile(
      bin, args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        // SIGKILL: a task that ignores SIGTERM must not hang the night loop.
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        const timedOut = Boolean(e && (e.killed || e.signal === "SIGKILL"));
        const exitCode =
          e && typeof e.code === "number" ? (e.code as unknown as number) : e ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode, timedOut });
      },
    );
  });

const READ_ONLY_TOOLS = "Read Glob Grep WebFetch WebSearch";

export function buildClaudeArgs(task: Pick<Task, "prompt" | "permissionClass" | "permissionMode">): string[] {
  const args = ["-p", task.prompt, "--output-format", "json"];
  if (task.permissionClass === "read-only") {
    args.push("--allowedTools", READ_ONLY_TOOLS);
  } else {
    args.push("--permission-mode", task.permissionMode);
  }
  return args;
}

/**
 * Extract actuals from one headless result JSON. Tokens come straight from
 * the result payload — never derived from /usage % deltas. Raw JSON is
 * preserved verbatim (same philosophy as window_readings.raw).
 */
export function parseResultJson(stdout: string): RunActuals {
  const base: RunActuals = {
    model: null, sessionId: null, inputTokens: null, outputTokens: null,
    cacheCreationTokens: null, cacheReadTokens: null, totalCostUsd: null,
    durationMs: null, result: "error", error: null, rawJson: stdout.trim() || null,
  };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { ...base, error: "unparseable result JSON" };
  }
  const usage = (j.usage ?? {}) as Record<string, unknown>;
  const modelUsage = (j.modelUsage ?? {}) as Record<string, { inputTokens?: number; outputTokens?: number }>;
  // Dominant model = the one with the most output tokens.
  let model: string | null = null;
  let best = -1;
  for (const [name, mu] of Object.entries(modelUsage)) {
    const out = mu.outputTokens ?? 0;
    if (out > best) { best = out; model = name; }
  }
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  // A run whose tools were denied did not actually do the work — surface it.
  const denials = Array.isArray(j.permission_denials) ? j.permission_denials.length : 0;
  const error = j.is_error
    ? String(j.result ?? "headless run reported error")
    : denials > 0
      ? `${denials} permission denial(s) — work likely incomplete`
      : null;
  return {
    ...base,
    model,
    sessionId: typeof j.session_id === "string" ? j.session_id : null,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    totalCostUsd: num(j.total_cost_usd),
    durationMs: num(j.duration_ms),
    result: typeof j.subtype === "string" ? j.subtype : j.is_error ? "error" : "unknown",
    error,
  };
}

export interface RunDeps {
  exec?: ExecFn;
  claudeBin?: string;
}

export interface RunOutcome {
  actuals: RunActuals;
  success: boolean;
}

export async function runClaudeTask(
  task: Task,
  cwd: string,
  timeoutMs: number,
  deps: RunDeps = {},
): Promise<RunOutcome> {
  const exec = deps.exec ?? realExec;
  const bin = deps.claudeBin ?? "claude";
  const { stdout, stderr, exitCode, timedOut } = await exec(bin, buildClaudeArgs(task), {
    cwd, timeoutMs,
  });
  const actuals = parseResultJson(stdout);
  if (timedOut) {
    actuals.result = "timeout";
    actuals.error = `timed out after ${Math.round(timeoutMs / 60000)}m (SIGKILL)`;
  } else if (exitCode !== 0) {
    actuals.result = "error";
    const detail = `claude exited ${exitCode}: ${stderr.slice(0, 500)}`;
    actuals.error = actuals.error ? `${actuals.error}; ${detail}` : detail;
  }
  const success = exitCode === 0 && !timedOut &&
    actuals.result === "success" && !actuals.error;
  return { actuals, success };
}

/** git worktree isolation for write-scoped tasks (injectable exec, same seam). */
export async function addWorktree(
  repoCwd: string,
  worktreePath: string,
  exec: ExecFn = realExec,
): Promise<void> {
  const { exitCode, stderr } = await exec(
    "git", ["-C", repoCwd, "worktree", "add", "--detach", worktreePath],
    { cwd: repoCwd, timeoutMs: 60_000 },
  );
  if (exitCode !== 0) {
    throw new Error(`git worktree add failed: ${stderr.slice(0, 500)}`);
  }
}
