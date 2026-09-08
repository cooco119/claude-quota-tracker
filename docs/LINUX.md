# Linux support

`quota-tracker` supports Linux with two scheduler modes.

## Linux with systemd --user

`quota install` installs the launcher/runtime and, when `systemctl --user` is usable, creates and enables:

- `~/.config/systemd/user/quota-tracker.service`
- `~/.config/systemd/user/quota-tracker.timer`

The timer runs `quota poll` every five minutes.

## Linux without systemd

Containers, Distrobox/minimal environments, remote shells, and other no-init sessions are supported through the portable daemon:

```bash
quota daemon
```

or from a source checkout:

```bash
npm run build
npm run daemon
```

The daemon performs the same repeated `pollOnce()` operation using `pollIntervalSeconds` from config. It is suitable for any external supervisor (`tmux`, `screen`, container supervisor, cron wrapper, etc.). `quota install` does **not** fail when systemd is unavailable; it installs the runtime and prints the daemon fallback command.

## Desktop integration

- macOS notifications: `osascript`
- Linux notifications: `notify-send` when installed; absence is non-fatal
- macOS browser opener: `open`
- Linux browser opener: `xdg-open` when installed; absence is non-fatal
- SwiftBar remains macOS-only and is skipped on Linux

The MCP server, quota tracking, SQLite queue, pacing governor, task executor, and dashboard HTTP server do not require systemd.
