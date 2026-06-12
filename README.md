# Claude Quota Tracker

> Track your Claude Max usage windows, never waste a quota window, and schedule
> heavy work for the quiet hours — a local-first macOS companion for Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#requirements)
[![Node ≥22.5](https://img.shields.io/badge/node-%E2%89%A522.5-339933.svg?logo=node.js&logoColor=white)](#requirements)
[![Runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#how-it-works)
[![For Claude Code](https://img.shields.io/badge/for-Claude%20Code-8A2BE2.svg)](https://claude.com/claude-code)

![Claude Quota Tracker dashboard](docs/dashboard.png)

Claude's Max plan gives you a **5-hour rolling session window** and **weekly
windows** that quietly reset whether or not you used them. Quota Tracker keeps a
time series of your usage, forecasts whether you're on pace to fill (or waste) a
window, nudges you when you're under-using, surfaces your **whole** token usage
across every Claude Code project, and can run deferrable batch work **unattended
during the quietest night hours** so a window never goes to waste.

Everything runs locally. No account, no server, no telemetry — it reads
`claude -p "/usage"` and your local Claude Code session logs, and stores them in
a SQLite file on your machine.

---

## Features

- **📊 Usage tracking & forecast** — polls your 5h / weekly windows every 5
  minutes, forecasts the reset-time usage from your burn rate, and tells you
  *when* you'll hit 100% (not a meaningless ">100%").
- **🔔 Under-use nudges** — a macOS notification when a window is on pace to
  reset unused, so you can put the spare capacity to work. (Over-use and
  schedule-hint modes ship off by default.)
- **🌙 Night scheduler** — queue heavy, non-urgent tasks and they run
  unattended via headless `claude -p` during your configured night window,
  starting at the historically **lowest-usage hour**. Permission-triaged
  (read-only / write-scoped / destructive) with explicit confirmation.
- **🖥️ Menubar glance** — a [SwiftBar](https://swiftbar.app) plugin shows the
  most urgent window at a glance, with all three windows + sparklines in the
  dropdown. Reads cached data only; never calls Claude.
- **📈 Local web dashboard** — gauges, **total** per-model token usage, a
  GitHub-style contribution heatmap, estimate-vs-actual accuracy, and queue
  state. Self-contained inline SVG; opens with one menubar click.
- **🧩 Claude Code plugin** — a skill + `UserPromptSubmit` hook so Claude itself
  becomes quota-aware and can offer to defer heavy work to the night queue.

---

## Screenshots

**`quota status`** — current windows, forecast, and 7-day totals:

```text
Session (5h): 39%  → ~58% by reset · resets Jun 13 1:40 AM
Week (all models): 59%  → ~72% by reset · resets Jun 13 11:00 AM
Week (Sonnet): 32%  → ~39% by reset · resets Jun 13 11:00 AM
7d: $0.97 · 1,699,099 tok · 1 runs   (total Claude Code usage · session-log based)
```

**Menubar** (SwiftBar) — glance + dropdown:

```text
CQ 5h 39%
---
Session (5h): 39% → ~58% by reset Jun 13 1:40 AM
-- ▂▂▂▂▂▂▁▁▁▁▁▁▁▁▁▃
Week (all models): 59% → ~72% by reset Jun 13 11:00 AM
-- ▂▃▃▄▄▄▄▄▄▄▄▄▅▅▅▅
Open Dashboard
```

> The dashboard and CLI messages are currently in Korean. PRs for i18n are very
> welcome.

---

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node ≥ 22.5** — uses the built-in `node:sqlite`; no native modules
- **[Claude Code](https://claude.com/claude-code) CLI**, logged in (so
  `claude -p "/usage"` works)
- *(optional)* [SwiftBar](https://swiftbar.app) for the menubar plugin —
  installed automatically by `setup.sh` if Homebrew is present

---

## Install

```bash
git clone https://github.com/cooco119/claude-quota-tracker.git
cd claude-quota-tracker
npm install
bash scripts/setup.sh
```

`setup.sh` compiles the project, installs a tiny launcher to
`~/.local/bin/quota`, registers a launchd agent that polls every 5 minutes,
and starts the SwiftBar menubar. Config and data live in `~/.quota-tracker/`.

To remove: `quota uninstall` (your data is preserved).

> Why a launcher and not a single binary? An ad-hoc-signed Node SEA binary gets
> SIGKILLed by the Apple Silicon kernel once `cp` breaks its signature. Node is
> already a hard dependency, so a launcher is lighter and far more robust.
> `scripts/build-binary.sh` can still bake a standalone binary if you want one.

---

## Usage

```bash
quota status                 # current windows, forecast, 7-day totals (--json available)
quota tasks                  # the night queue + recent runs
quota dashboard --open       # open the web dashboard (idempotent)

# Queue a heavy task to run unattended at the quietest night hour:
quota enqueue --night --prompt "..." --size m --perm read-only

# Run a destructive/urgent task manually, while you watch:
quota executor --task <id>
```

`--perm` triages how the task may run unattended:

| class | runs unattended | sandbox |
|---|---|---|
| `read-only` | ✅ | read-only tools only |
| `write-scoped` | ✅ | isolated `git worktree` |
| `destructive` | ❌ (manual only) | — |

Night execution holds until your configured floor (default **2 AM**) and, once a
few days of history exist, targets the lowest-burn hour of the window.

**What "unattended" honestly means** — three limits to know before you rely on it:

- **The machine must be awake.** launchd's `StartInterval` does not fire (or wake
  the Mac) during sleep, so a sleeping Mac runs nothing. Keep it awake for the
  window, e.g. `sudo pmset repeat wake MTWRFSU 01:55:00` (wake before the floor)
  or `caffeinate -s` while plugged in. `quota uninstall` doesn't touch pmset.
- **The session window throttles throughput.** Running `claude -p` burns your 5h
  session window, and execution pauses when it crosses `executor.sessionGuardPct`
  (default 80%). So one night fills roughly one or two session windows' worth of
  work, not the whole weekly window — raise `sessionGuardPct` if you want it to
  burn harder overnight.
- **It runs tasks that fit the time left.** A task whose size-timeout exceeds the
  remaining window is skipped in favor of smaller tasks that fit (it runs earlier
  on a later night), so the queue keeps draining rather than stalling.

---

## Claude Code plugin

This repo is also a Claude Code marketplace (`.claude-plugin/marketplace.json`):

```text
/plugin marketplace add cooco119/claude-quota-tracker
/plugin install quota-tracker@quota-tracker-marketplace
```

It installs a **skill** (so Claude can read your usage and defer heavy work via
the `quota` CLI) and a **`UserPromptSubmit` hook** that nudges Claude when your
session window is filling. The plugin is the Claude integration only — you still
run `bash scripts/setup.sh` once to install the CLI/daemon.

---

## How it works

```
claude -p "/usage" ──poll(5m)──▶ window_readings ──▶ forecast ──▶ notify / menubar
                                        │
~/.claude/projects/*.jsonl ─ingest──▶ usage_events ─┐
                                                     ├──▶ dashboard
quota enqueue ──▶ tasks ──night executor──▶ task_runs┘
```

- **Zero runtime dependencies.** Everything is the Node standard library
  (`node:sqlite`, `node:http`, `fs`). The dashboard's charts are hand-rolled
  inline SVG — no CDN, no build step, works offline.
- **Two separate data sources, on purpose.** `usage_events` (ingested from your
  Claude Code session logs, deduped by `message.id`) is your total usage and
  drives the dashboard's model/heatmap/token charts. `task_runs` is only the
  orchestrator's own runs and powers cost + size-estimate accuracy. They are
  never mixed into one number.
  - *Scope:* out of the box this reads `~/.claude/projects`, where standard
    Claude Code logs every project. If you run a **custom harness** (e.g. CCS, or
    a non-default `CLAUDE_CONFIG_DIR`) that logs elsewhere, add its root to
    `config.ingest.extraRoots` — otherwise the dashboard "total" undercounts.
- **Idempotent, incremental ingest.** Session logs are read from a per-file
  byte cursor (multibyte-safe), deduped on the `message.id` primary key, and
  re-running is a no-op. A 26 MB / 300-file corpus ingests in well under a
  second; subsequent polls only read what changed.

---

## Configuration

`~/.quota-tracker/config.json` (see [`config.example.json`](config.example.json)):

- `notify` — nudge modes, thresholds, quiet hours, cooldown
- `nightWindow` — `start`/`end` (local wall-clock) + a one-time confirmation
- `executor` — `sessionGuardPct` (default 80), `nightFloorHHMM` (default
  `02:00`), per-size timeouts, `maxAttempts`
- `dashboard` — `port` (default 47600), `idleShutdownMin`
- `ingest` — `extraRoots` (extra session-log roots for custom harnesses; `~/`
  expands to `$HOME`)

---

## Privacy

Everything stays on your machine. Quota Tracker reads `claude -p "/usage"` and
your local `~/.claude/projects/*.jsonl` session logs, and writes a SQLite file
under `~/.quota-tracker/`. Nothing is sent anywhere. Token stats reflect Claude
Code usage only (not claude.ai / the web app).

---

## Development

```bash
npm run build        # tsc → dist/
npm test             # vitest (116 tests)
npm run typecheck
```

The codebase is plain TypeScript ESM. `store.ts` / `forecast.ts` / `ingest.ts`
are importable libraries; everything validates at system boundaries.

---

## License

[MIT](LICENSE) © jaejun.lee

🤖 Built with [Claude Code](https://claude.com/claude-code).
