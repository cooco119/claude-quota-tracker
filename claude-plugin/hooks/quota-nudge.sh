#!/bin/sh
# UserPromptSubmit hook: when the 5h session window is filling, emit a one-line
# nudge so Claude can proactively offer to schedule heavy/non-urgent work for the
# night executor. Reads cached usage only — never calls claude, never consumes
# quota. Silent (and exit 0) when quota isn't installed or usage is below the
# threshold, so it never blocks prompt submission.
QUOTA="$(command -v quota 2>/dev/null || echo "$HOME/.local/bin/quota")"
[ -x "$QUOTA" ] || exit 0
"$QUOTA" hint 2>/dev/null || true
exit 0
