# MCP quota scheduler

The fork exposes the quota-aware scheduler over stdio MCP.

## Enable pacing

Copy `config.example.json` to your active config and enable:

```json
{
  "pacing": {
    "enabled": true,
    "slackPct": 5,
    "sessionWindowHours": 5,
    "weeklyWindowHours": 168,
    "continuousEnabled": true,
    "deadlineSafetyMinutes": 15,
    "adaptiveMinSamples": 3
  }
}
```

`enabled` turns on quota pacing. `continuousEnabled` allows tasks that were **explicitly** submitted with `continuous: true` to run outside the confirmed night window.

Hard guards in `executor.sessionGuardPct` and `executor.weeklyGuardPct` remain authoritative and are never bypassed by pacing, deadlines, or `run_now`.

## MCP configuration

After `npm run build`, start the server with:

```bash
npm run mcp
```

or, when using the installed/baked CLI:

```bash
quota mcp
```

Example `.mcp.json` entry:

```json
{
  "mcpServers": {
    "quota-tracker": {
      "command": "quota",
      "args": ["mcp"]
    }
  }
}
```

## Tools

### `submit_task`

Queues work and records scheduler metadata.

Important arguments:

- `prompt`: Claude Code task.
- `cwd`: repository/work directory.
- `size`: `xs|s|m|l|xl`.
- `intent`:
  - `interactive`: manual-only; pacing never delays a manual `run_now`.
  - `deadline`: obey pacing while there is time, then bypass pacing at the latest safe start.
  - `opportunistic`: only runs when both quota windows have paced capacity.
- `deadline`: required for `deadline`; ISO-8601 or epoch milliseconds.
- `permission`: `read-only|write-scoped|destructive`.
- `continuous`: explicit opt-in to unattended execution outside the night window. Ignored for `interactive` and destructive tasks.
- `estimated_tokens`: optional task-specific override for adaptive estimation.

### `get_quota_status`

Returns current 5-hour and weekly usage/reset values plus hard-guard status.

### `get_pacing_status`

Returns the ideal consumption target, allowed target including slack, and the binding window when work should be held.

### `list_tasks`

Returns the existing queue plus scheduling intent/deadline/pause/continuous metadata.

### `pause_task` / `resume_task`

Temporarily remove/restore a task from automatic admission without changing the underlying queue lifecycle.

### `run_now`

Runs a specific queued task through the existing manual executor. Pacing is bypassed, but hard quota guards and Claude permission rules remain in force.

## Scheduling model

For each quota window:

```text
target usage = usable budget × elapsed fraction
allowed usage = min(usable budget, target usage + slack)
```

A queued opportunistic task starts only when both the 5-hour and weekly windows are at or below their allowed usage. The first window over its allowance is the bottleneck.

The poller launches at most one paced task per fresh quota snapshot. It never drains multiple tasks using the same stale percentage reading.

## Adaptive estimation

Completed run history is grouped by task size. After `adaptiveMinSamples` successful runs, the scheduler uses the median token count plus a 15% safety margin instead of the static size estimate. Until enough data exists, static estimates remain the fallback. A task-specific `estimated_tokens` override wins over both.

Adaptive token estimates currently improve deadline latest-safe-start calculations. They intentionally do **not** pretend that Anthropic quota percentage is linearly convertible to token count.

## Continuous execution safety

Continuous execution requires all of:

1. global `pacing.continuousEnabled=true`;
2. explicit `continuous: true` on the task;
3. a permission class allowed unattended by the existing triage policy;
4. a non-interactive scheduling intent;
5. fresh quota data and passing hard guards.

`write-scoped` tasks still run in the existing isolated git worktree. `destructive` tasks remain manual-only.
