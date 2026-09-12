---
name: budget
description: Show or set this chat's usage budget against your account rate limits.
---

Run this command and show the user its raw output verbatim. Do not summarise it,
do not add commentary, and do not re-run it with different arguments.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/budget.mjs" "$CLAUDE_SESSION_ID" $ARGUMENTS`

Usage the user may not know:
- `/budget` - show current gauges, thresholds and what would happen right now
- `/budget 80` - set this chat's 5-hour ceiling to 80%
- `/budget weekly 70` - set this chat's weekly ceiling
- `/budget money 60` - set this chat's metered-spend ceiling
- `/budget off` / `/budget on` - disable or re-enable the guard for this chat
