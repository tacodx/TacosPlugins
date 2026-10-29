# board: a live board beside the chat

Status: built 2026-10-29. The owner's reason: several sessions can work hard at
once while it feels as if nothing is happening, and a status picture drawn by
hand on request goes stale at once. `/board` opens a pane that stays beside the
chat and refreshes itself.

## What the pane shows, in order

1. Commits today, lines added today, commits in the last 7 days.
2. Commits per hour over the last 30 hours, one hue, so a quiet night is a gap.
3. Commits per project per day over the last 7 days, stacked, a fixed colour per project.
4. The sessions working right now.
5. The rows of one Markdown table, the plan: number, name, status; struck rows are done.

No list of things waiting on the person: asked for and then dropped.

## Shape

The same two parts as `reflect`, for the same reason: a hooks module has no
Node, cannot run git and cannot read a file over 4 MiB.

- `reader/`: a Node program, `cli.mjs view`, that reads git, the session list
  and the plan and prints one JSON View. It owns `~/.claude/tacos/board/`.
- `hooks/`: the mod. `register.tsx` holds every hook and every call on `$`;
  `board.tsx`, `shape.mjs`, `charts.mjs` and `format.mjs` are pure and turn a
  View into five SVG cards (desktop) or a few lines of text (other surfaces).
  The cards are reflect's: a dark surface of their own, serif figures over
  monospace labels.

The mod refreshes when `/board` opens the pane, when **Refresh now** is
pressed, and from a one-minute timer started at `session.start` that runs the
reader only while the pane is open and the last refresh is `refreshMinutes`
old. A refresh started earlier never overwrites a newer one.

## Decisions

**Sessions at work.** The mod API lists no other sessions. The ListAgents tool
does, and a mod could call it with `$.tool.call`, but a plugin's tool call runs
every other plugin's catch-all tool hooks; with claude-mem installed each call
would become an observation a model then summarises. So the reader reads what
ListAgents reads: Claude Code's `~/.claude/sessions/<pid>.json`, one file per
running session with its name, folder and busy or idle status. Only `*.json` is
opened, never the key files beside them. A session counts while its pid runs
and, where `/proc` can tell, still has the start time Claude Code recorded.
Sessions started through the SDK are left out. The format is Claude Code's own
and may change: when no file in it can be used, the card falls back to
transcripts written to in the last ten minutes and says so.

**Commits.** `git log --all` per repo, leaving out the stash and notes refs,
since 8 days ago, with `--numstat`. Each repo's result is cached under a hash of
`git show-ref --head`, so a refresh of an unchanged repo costs one git call;
`--all` means a new branch in a worktree changes the key even when HEAD does
not. A commit counts when its author email is one the listed repos commit as
(their `user.email`), or one listed under `authors`; a commit in two repos is
counted once. Hour and day come from the author date in the local zone, so
rebased copies land where the work was done. Lockfiles add no lines. Git runs
with lazy fetching off, and a partial clone (a promisor remote) is read without
file contents, so the board never touches the network; its lines are not
counted and the pane says so. A repo git cannot read keeps its earlier entry,
and after 45 seconds the repos not yet read wait for the next refresh, so one
hanging repo cannot run the reader into the pane's limit of two and a half
minutes.

**Colours.** Eight slots, the dark steps of the dataviz reference palette in
its validated order, checked against this card's surface (`#161615`): every
adjacent pair passes CVD separation and the normal-vision floor, all eight
clear 3:1. The reader keeps a book, project to slot, in its cache. Only the
eight busiest active projects are coloured; the rest are neutral and drawn as
Other. A coloured project keeps its slot while no other coloured project holds
it; one without a slot takes the lowest slot nobody in the book holds, else one
held only by a project that is not coloured now, which gives it up. The
hours card is one series in reflect's accent, which is not one of the eight.

**Settings.** The repo is public, so no one's paths are in the code. The first
run writes `config.json` with what it finds: `~/Projects/*`, plus
`~/Projects/<folder>/*` for every folder there that holds repos of its own.
`plan` starts empty; the person names a file and a section heading.

**Plan parsing.** The first table under the named heading (any level, case and
trailing colon ignored), up to the next heading of the same or a higher level;
with no heading named, the first table in the file. `\|` stays inside its cell.
A row is done when its first or second cell is wrapped in `~~`. A bold phrase
that opens the third cell is its status.

## Not done

- Opening the pane unasked at session start: a pane in every session is in the
  way, and a mod may open one unasked only on a wide enough surface.
- Work that has not reached a commit: the sessions card is the only sign of it.
- Remote and cloud sessions: they are not in the local session list.
