---
name: quota-tracker
description: Check Claude Max20 quota (5h session + weekly windows) and schedule heavy work to run unattended during low-usage night hours, via the local `quota` CLI. Triggers when the user asks about their Claude usage/limits/resets, or wants to defer a slow task to off-hours instead of running it now. Trigger phrases (the user often types Korean) - "how much quota left", "how much have I used", "when does it reset", "at this rate will I run out", "run this tonight", "schedule for off-hours", "queue this up", "do this later", "what's in the queue", "open the dashboard", "quota status", "내 쿼터", "사용량 얼마나 남았어", "한도 얼마나 썼어", "리셋 언제", "이거 밤에 돌려줘", "야간에 예약해줘", "스케줄러에 넣어줘", "나중에 실행", "큐에 뭐 있어", "대시보드 열어줘".
---

# quota-tracker

Wraps the locally installed `quota` CLI (a launcher at `~/.local/bin/quota`)
to read Claude Max20 usage and schedule tasks onto the night executor. If `quota`
is not on PATH, call `~/.local/bin/quota` directly.

Data scope: token/cost/task stats come from **tasks that quota-tracker itself ran**
(`task_runs`), not your total Claude usage. Window usage percentages come from
`claude -p "/usage"` snapshots.

## Check usage

```bash
quota status           # human: 3 windows (%, forecast, reset) + 7-day KPI
quota status --json     # machine: structured windows[]/kpi JSON
```

Each window in `--json`: `pct`, `resetEpochMs`, `forecast.predictedPctAtReset`,
`forecast.burnRatePctPerHour`, and `exhaustionEpochMs` (epoch when usage is on
pace to hit 100%, or null if it won't fill before reset). When the user asks
"how much is left / when does it reset / will I run out at this rate?", read this
and answer.

## Schedule a task onto the night executor

Heavy or non-urgent work can be deferred to run **unattended during the quietest
night hours instead of now**:

```bash
quota enqueue --night --prompt "<what to do>" --size <xs|s|m|l|xl> --perm <read-only|write-scoped|destructive> [--cwd <path>] [--priority <N>]
```

- `--size`: rough scale (xs ≈ 10K to xl ≈ 400K tokens). Estimates self-correct as
  actuals accumulate.
- `--perm`:
  - `read-only` — reads/analysis/reports only. Safe to run unattended.
  - `write-scoped` — edits repo files under a git-worktree sandbox. Safe unattended.
  - `destructive` — deletes, pushes, external sends. **Not unattended**; runs only
    while the user watches.
- `--night`: runs at the night window's lowest-usage hour (defaults to after 2 AM,
  converging on the historically quietest hour as data accumulates). First use
  auto-confirms the night window.

**When to offer scheduling**: if the user asks for a long-running task (large
refactor, full test sweep, migration, bulk doc generation) whose result isn't
needed right now, or if `quota status` shows the session window near its guard
(default 80%) so running now would threaten the limit — offer "run it now, or
schedule it for tonight when the window is idle?" If the user explicitly wants it
now, just do it.

A task registered as `destructive` will not run unattended; to run it:

```bash
quota executor --task <id>   # manual run, while the user watches
```

## Inspect the queue and runs

```bash
quota tasks            # #id [status] size/perm/window pri — prompt
quota tasks --json      # structured (status: queued|running|done|failed|carried_over)
```

Use for "what's queued / what ran overnight / did that task finish?". `--json`
exposes each task's status, attempts, and resumeSessionId.

## Dashboard

```bash
quota dashboard --open  # open the usage dashboard in the browser (idempotent)
```

Shows gauges, per-model tokens, a contribution heatmap, estimate accuracy, and
queue state on one page. Use for "dashboard / stats screen / show me the charts".

## Notes

- Polling and night execution run automatically in the background via launchd.
  Claude normally does not need to call `quota poll` or `quota executor` directly
  — `enqueue` is enough to schedule work.
- Scheduled night tasks only run if **the machine is awake** (launchd does not fire
  during sleep). If the user says "it didn't run overnight," check power/sleep
  settings first.
- Configuration lives in the `config.json` shown by `quota paths` (guard
  thresholds, `nightFloorHHMM`, quiet hours, etc.).
```
