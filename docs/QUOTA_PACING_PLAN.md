# Quota-aware pacing plan

## Goal

Turn the existing deferred-task executor into a quota-aware scheduler that spreads Claude usage across the available 5-hour and weekly windows instead of only reacting near exhaustion.

The first implementation deliberately keeps the existing unattended/night safety model intact. It changes *when an already-eligible task may start*, not what permissions it gets or when unattended execution is allowed.

## Existing pieces to reuse

- Claude 5-hour and weekly usage snapshots from `latest.json`.
- Persistent task queue and claim/retry lifecycle.
- Existing hard guards (`sessionGuardPct`, `weeklyGuardPct`).
- Night-window confirmation and permission triage.
- Executor loop and stale-run recovery.

## Phase 1 — pacing governor

Add a pure, deterministic policy function that computes an ideal consumption curve for each quota window:

- infer window start from `resetEpochMs - windowDurationMs`;
- compute elapsed fraction of the window;
- compute target usage as `guardPct * elapsedFraction`;
- allow a configurable burst/slack above the target;
- block new opportunistic dispatch when actual usage is above the paced target;
- evaluate both the 5-hour and weekly windows, with either one able to become the bottleneck;
- keep the existing hard guards as final safety ceilings.

This means a weekly window at 60% elapsed should normally have consumed roughly 60% of its configured usable budget. If actual consumption is materially ahead of that curve, queued work waits. If it is behind, queued work can run.

## Phase 2 — task semantics

Add explicit scheduling intent instead of overloading `--night`:

- `interactive`: never delayed by the quota scheduler;
- `deadline`: may be delayed while slack remains before its deadline;
- `opportunistic`: run only when the governor reports spare quota.

Add optional deadline and estimated-cost metadata to queued tasks.

## Phase 3 — MCP surface

Expose the scheduler through MCP without duplicating policy:

- `submit_task`
- `get_quota_status`
- `get_pacing_status`
- `list_tasks`
- `pause_task`
- `resume_task`
- `run_now`

The MCP server should be a thin adapter over the existing store/executor/governor modules.

## Phase 4 — adaptive estimation

Use completed runs to learn expected consumption by task size/model and improve admission decisions. Until enough history exists, use conservative static estimates.

## Phase 5 — continuous dispatch

Generalize unattended execution beyond the current night-only window while preserving explicit user opt-in and permission isolation. This is intentionally separate from Phase 1 so quota policy can be tested without weakening existing safety gates.

## Phase 1 acceptance criteria

1. Pacing is disabled by configuration by default for backwards compatibility.
2. Missing/reset-invalid quota data fails closed when pacing is enabled.
3. Both session and weekly windows participate in the decision.
4. Existing hard guards remain authoritative.
5. Pure policy tests cover ahead-of-curve, behind-curve, reset-boundary, slack, and disabled behavior.
6. Executor logs explain which window caused a pacing pause.
