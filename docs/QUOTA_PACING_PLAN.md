# Quota-aware pacing plan

## Goal

Turn the existing deferred-task executor into a quota-aware scheduler that spreads Claude usage across the available 5-hour and weekly windows instead of only reacting near exhaustion.

Status: **implemented on `feature/quota-aware-pacing`**.

## Reused foundation

- Claude 5-hour and weekly usage snapshots from `latest.json`.
- Persistent task queue and claim/retry lifecycle.
- Existing hard guards (`sessionGuardPct`, `weeklyGuardPct`).
- Night-window confirmation and permission triage.
- Existing executor, worktree isolation and stale-run recovery.

## Phase 1 — pacing governor ✅

Implemented in `src/pacing.ts`.

- Linear ideal-consumption curve for both 5-hour and weekly windows.
- Configurable slack/burst allowance.
- Either quota window can become the bottleneck.
- Missing or stale reset data fails closed when pacing is enabled.
- Existing hard guards remain authoritative.

## Phase 2 — task semantics ✅

Implemented with sidecar scheduling metadata in `src/scheduler-meta.ts` and pure admission policy in `src/scheduler-policy.ts`.

- `interactive`: pacing does not delay manual execution.
- `deadline`: obeys pacing until the computed latest safe start, then may bypass pacing but never hard guards.
- `opportunistic`: only admitted when pacing reports spare capacity.
- Optional deadline and estimated-token override.
- Pause/resume metadata without mutating the legacy task lifecycle schema.

## Phase 3 — MCP surface ✅

Implemented in `src/mcp-server.ts` using stdio JSON-RPC/MCP without an additional runtime dependency.

Tools:

- `submit_task`
- `get_quota_status`
- `get_pacing_status`
- `list_tasks`
- `pause_task`
- `resume_task`
- `run_now`

See `docs/MCP_SCHEDULER.md`.

## Phase 4 — adaptive estimation ✅

Implemented in `src/adaptive-estimate.ts`.

- Static size estimates are used during cold start.
- After a configurable minimum number of successful same-size runs, the scheduler uses the historical median plus a 15% safety margin.
- A task-specific estimate override takes precedence.
- Adaptive estimates improve deadline latest-safe-start calculation.
- Token count is deliberately **not** treated as linearly equivalent to Anthropic quota percentage.

## Phase 5 — continuous dispatch ✅

Implemented through the poller and paced one-shot executor.

- `continuousEnabled` is a global opt-in.
- Each task additionally requires explicit `continuous: true`.
- `interactive` and destructive tasks never become continuous unattended work.
- Existing unattended permission triage and write-scoped git worktree isolation remain unchanged.
- The poller launches at most one paced task per fresh quota snapshot; the queue is never drained using one stale percentage reading.

## Safety invariants

1. Hard 5-hour and weekly guards are never bypassed.
2. Missing/stale quota snapshots never authorize paced work.
3. Continuous execution requires global and per-task opt-in.
4. Destructive tasks remain manual-only.
5. Write-scoped tasks continue to use isolated git worktrees.
6. Only one paced executor may run at a time.
7. Every automatic task start is re-evaluated against a fresh poll cycle.

## Validation

- Unit coverage for pacing, scheduling intent/deadline behavior and adaptive estimation.
- GitHub Actions runs `npm run typecheck` and `npm test` on the branch/PR.
