# TacosPlugins: `night` design

**Date:** 2026-10-29
**Status:** Approved in conversation (two rounds of questions, then the plan). Being built the same night.
**Scope:** The fourth TacosPlugins plugin. An engine of small systemd user services that runs Claude Code
sessions through the night, a guard hook those sessions run under, and a mod pane to drive it. Standalone: does
not use `packages/core`.

---

## 1. Problem

The owner leaves the PC on overnight so that Claude Code sessions keep building. The nights so far were run by
hand, and each one lost work a different way:

- 28/29 October: the whole plan was done by 01:25; the sessions then sat idle until morning, and the watching
  session deleted its own heartbeat when everything reported done.
- 1/2 October: three sessions started their test suites at the same moment, RAM and zram swap filled, and the
  machine thrashed for four and a half hours until the app was killed by hand.
- Lights and monitors needed commands typed every evening, one of which (`kscreen-doctor --dpms off`) exits 0
  and leaves the screens on.
- A session-only cron dies with its session; a heartbeat in one session cannot restart that session.

The owner's words: one from-to window set in the tool; RGB off, fans and power down, screens off at "from"; watchers
for health, logs and errors; something that fixes sessions that stop; sessions working until the project is done or
he interrupts them; and in the morning one calm recap he can open anywhere, with what each session did, what is done
and left per project, the % done and the % gained overnight.

## 2. What this plugin does

| Part | What it is |
|---|---|
| `/night` | A pane beside the chat: set from and to, tick projects, pick 1 to 4 sessions, Arm, Start now, Stop; the night's live status; the recap |
| Dusk | At "from": lights off, fans to a quiet Night mode, power-saver held, screens off, the night's services started |
| Workers | Up to four headless Claude Code sessions, each in its own git worktree on a night branch, taking items from a queue |
| Queue | Built from the owner's plans (notes, roadmap rows, checklists), only work that needs no decision from him, each item saying why; refilled before it runs dry |
| Guard | A hook every worker runs under: no push, no merge onto a protected branch, no deploy, no sending, nothing outside its worktree; heavy tests one at a time |
| Watchers | health, logs, usage and a medic, each its own service with a heartbeat; a keeper timer watches the watchers |
| Dawn | At "to": everything back as it was, and the recap written and published. Workers keep going until Stop |
| Recap | One page: per project % done at dusk and now, per session what it did, commits per hour and per project, one short line for what needs the owner |

## 3. Decisions taken with the owner

| Question | Answer |
|---|---|
| What "% won" means | Points moved tonight: each project's % done from its own plan, at dusk and now |
| Which projects | Every open project note (Doing, Planned, Paused) that points at a git repo; client work and archived projects never; ticked on and off in the pane |
| What happens at "to" | Hardware back and the recap ready; workers keep working until Stop |
| Where the recap lives | In the pane, and in one private claude.ai artifact readable from any device on the account |
| When it arms | Only on nights the owner presses Arm |
| How free the workers are | Fully automatic, never parked on a dialog, behind a hard block list |
| How many at once | Up to four |
| How it stops | Stop in the pane; typing into one desktop session interrupts only that one |

## 4. Non-goals

| Not in v1 | Why |
|---|---|
| Resuming or answering the owner's desktop sessions | The app holds them and resumes them after a limit by itself; `claude --resume` on a held session only makes a hidden copy. Night watches them and writes down where they wait |
| Answering any permission dialog | Never, for anyone. A parked dialog is written down for the morning |
| Pushing, merging, opening pull requests | Work stays on local night branches until the owner looks |
| A Stop button reachable from the phone | Asked and declined: Stop lives in the pane |
| Fan curves set channel by channel | Night only switches whole CoolerControl modes, so the pump can never be put on a curve by this code |
| Cost in money | Same reason as usage-guard: not calibratable on a subscription |

## 5. Verified facts (2026-10-29, Claude Code 2.1.308 in the desktop app, CLI 2.1.292, Node 22.22.2)

### 5.1 Sessions

- Every live session writes `~/.claude/sessions/<pid>.json`: `sessionId`, `cwd`, `name`, `status` (`busy`,
  `idle`, `waiting` with `waitingFor` such as "permission prompt" or "dialog open"), `statusUpdatedAt`,
  `procStart` (field 22 of `/proc/<pid>/stat`, so a reused PID is caught), `entrypoint` (`claude-desktop`, `cli`,
  `sdk-cli` for claude-mem's observers), `hostSessionId` (the app's `local_<id>`). `busy` also covers a session
  whose turn ended while a background task runs, so "hung" needs more than `busy`.
- Transcripts are `~/.claude/projects/<cwd with / as ->/<sessionId>.jsonl`. A turn ended normally when the last
  records are an assistant `stop_reason: "end_turn"` and `stop_hook_summary`. A usage limit is a synthetic
  assistant record with `error: "rate_limit"` and `apiErrorParams.rate_limit_info.resetsAt` (epoch seconds).
- The desktop app keeps `~/.config/Claude/claude-code-sessions/<account>/<org>/local_<id>.json` (title, cwd,
  branch, permission mode, crash marks). It resumes its own sessions a minute after a limit resets.
- `claude --resume <id> -p` against a session another process holds starts a copy; the original is unchanged.
- Three `claude` binaries exist on this machine (2.1.76 stale in `/usr/local/bin`, 2.1.292 on `PATH`, 2.1.308 in
  the app's folder). `night doctor` records the newest.

### 5.2 Spikes run for this design

- **A hook can deny and rewrite under `bypassPermissions`.** With `--settings` naming a PreToolUse command hook,
  `claude -p --permission-mode bypassPermissions` had `git push origin main` refused with the hook's reason, and
  `echo spike-original` replaced by the hook's `updatedInput` before it ran (2.1.308). The model noticed the
  rewrite and said so, so the worker prompt says that test commands are wrapped in a lock.
- **A headless session can use the Artifact tool.** `claude -p --model haiku` listed the owner's artifacts. So the
  recap can be published at dawn without a window open.
- `claude -p` waits three seconds for stdin unless stdin is `/dev/null`; every spawn passes `/dev/null`.

### 5.3 The machine

- CoolerControl 5.1.1 on `127.0.0.1:11987`. Every endpoint except `/handshake` needs `Authorization: Bearer
  cc_<uuid>`, a token the owner creates once in its UI. Modes: `GET /modes`, `POST /modes-active/{uid}`; none are
  defined yet. `fan1` is the AIO pump at `speed_fixed = 50` (its stall threshold is about 41 %, and a stalled pump
  takes the CPU from 39 to 76 °C in 45 s); `fan2` the radiator fans on a curve with a 30 % floor; `fan6`, `fan7`
  the case fans on a curve over max(CPU, GPU junction).
- power-profiles-daemon 0.30. The day profile is already power-saver, so the night holds it rather than changes
  it: `powerprofilesctl launch -p power-saver -r night -- <cmd>` keeps it for the life of the process.
- Screens off: the KDE powerdevil global shortcut, invoked as `qdbus-qt6 org.kde.kglobalaccel
  /component/org_kde_powerdevil org.kde.kglobalaccel.Component.invokeShortcut "Turn Off Screen"` (`/usr/bin/qdbus`
  is the Qt 4 one). On: `kscreen-doctor --dpms on`. User services have `DBUS_SESSION_BUS_ADDRESS` and
  `WAYLAND_DISPLAY`.
- RGB has its own script on this machine; it takes about two minutes and its exit code proves nothing.
- systemd: lingering is on. `$HOME` inside a `systemd-run` command expands to nothing, so units carry absolute
  paths.
- 32 GB RAM, 8 GiB zram plus zswap, `/tmp` a 16 G tmpfs, the root disk at 92 %. `systemd-oomd` is off, so nothing
  breaks a thrash unless night does.
- usage-guard keeps `~/.claude/tacos/usage-cache.json` fresh (five-hour and weekly percent and `resetsAt`) while
  any session runs. Night reads it and the transcripts' limit records, and never reads or refreshes credentials.

## 6. Architecture

```
 pane (/night, a mod) --process.run--> bin/night.mjs  <--systemd units--+
                                           |                              |
            ~/.claude/tacos/night/config.json, current.json               |
            ~/.claude/tacos/night/nights/<date>/  (queue, workers,        |
                  events, heartbeats, snapshot, recap)                    |
                                                                          |
 night-dusk.timer -> night-dusk.service -> dusk steps -> night.target ----+
 night.target wants: night-conductor, night-health, night-logs, night-usage, night-medic,
                     night-power, night-inhibit, night-worker@1..N
 night-keeper.timer (every 2 min, and 1 min after boot) -> night keep
 night-dawn.timer  -> night-dawn.service -> dawn steps, recap, publish
```

Every decision is a pure function in `lib/` with its own tests; the services are thin loops around them. Every
write is atomic (write to a temporary file, rename), and every read tolerates a missing or broken file, so any
process may be killed at any moment and its next start continues.

### 6.1 Files

| Path | Holds |
|---|---|
| `~/.claude/tacos/night/config.json` | The owner's settings: window, sessions, projects, sources, protected branches, hardware commands, models, artifact URL |
| `~/.claude/tacos/night/current.json` | The night in progress: date, phase (`armed`, `dusk`, `night`, `day`, `stopped`), the window as instants, which dusk and dawn steps ran |
| `nights/<date>/queue.json` | Items and their state; `queue.md` mirrors it for people and for desktop sessions |
| `nights/<date>/workers/<slot>.json` | What a worker holds: item, project, worktree, session id, last event time, limited until |
| `nights/<date>/events.jsonl` | One line per thing that happened: blocks, restarts, limits, health verdicts, dusk and dawn steps |
| `nights/<date>/heartbeats/<name>.json` | Each service's last beat |
| `nights/<date>/sessions.json` | The medic's view of every live session |
| `nights/<date>/snapshot.json` | Each project's % done at dusk |
| `nights/<date>/recap.json`, `recap.html` | The morning recap |

The date is the local date on which the night started. Personal paths, project names and the artifact URL live in
`config.json` only; the code's defaults are generic, and `night doctor` says what is missing.

### 6.2 Window and arming

- `night set <from> <to>` stores the window (the pane writes through it). `night arm` computes the next "from"
  and the "to" after it (across midnight and daylight-saving changes), writes `current.json` as `armed`, and
  writes `night-dusk.timer` and `night-dawn.timer` with those exact instants and `Persistent=true`. `night disarm`
  removes them. `night start` is arm-and-dusk-now.
- At "from", if there was keyboard or mouse input in the last five minutes, dusk waits ten minutes and shows a
  notification instead; it gives up waiting after an hour and starts anyway.
- `night install` writes every unit into `~/.config/systemd/user/` (pure text builders, absolute paths to node,
  claude and the plugin) and reloads systemd. `night uninstall` removes them and nothing else.

### 6.3 Dusk and dawn

Each step is independent, logged as an event, retried by the medic up to three times, and safe to run twice.

| Step | Dusk | Dawn |
|---|---|---|
| RGB | the configured "off" command | the configured "on" command |
| Fans | activate the Night mode | activate the Day mode |
| Power | start `night-power.service` (holds power-saver) | stop it |
| Sleep | start `night-inhibit.service` (`systemd-inhibit --what=sleep`, so screens may still blank) | stop it |
| Screens | the powerdevil "Turn Off Screen" shortcut | `kscreen-doctor --dpms on` |
| Services | start `night.target` | leave it running; workers go on |
| Recap | | write and publish |

Stop runs the dawn steps if the hardware is still in its night state, then stops `night.target`, writes the final
recap and disarms.

**The pump rule.** `fans.mjs` only ever activates whole modes; it never writes a channel. Before activating a
mode it reads it and refuses unless the pump channel is a fixed duty of at least 50 %. After activating it reads the
pump's RPM and, if it is under 1300, activates the Day mode and raises an event. A request filter rejects any
request whose path or body names the pump channel. All three are tested against a fake CoolerControl.

`night fans setup` runs once, after the owner saves a CoolerControl token to a mode-600 file the pane names. It
saves the current setup as the mode "Day", builds a "Night" mode that changes only the radiator fans (25 % up to
50 °C, the existing curve above) and the case fans (25 % up to 60 °C, then the existing curve), checks both with
the pump rule, and re-activates Day. If the API for building a mode is not usable, the pane instead shows a short
guide for making the Night mode in CoolerControl's own UI; night then only activates it by name. Without a token
the fan steps are skipped and the recap says so in one line.

### 6.4 Projects, queue and progress

- **Projects** are git repositories. The project notes (one Markdown file each, frontmatter `status`, `area`,
  `where`, `next`) say which repos are open: a note in Doing, Planned or Paused whose `where` resolves to a path
  inside a git repo, not in an excluded area (Client by default). Several notes may name one repo; they are that
  project's sources. The pane lists the projects, and the owner's ticks are stored as include and exclude lists.
- **Base branch**: night builds on the branch where work last happened in that repo, the most recently committed
  unprotected local branch (`git for-each-ref --sort=-committerdate refs/heads`), falling back to the default
  branch. Plans are read from that branch with `git show`, so no checkout is needed to read them.
- **Sources per project**: its notes (title, `next`, body), the roadmap rows that match a note (a note named
  "Session X ..." matches the row whose first cell is X; struck rows are done), checklists in the plan files
  matched by configurable globs (`- [ ]` and `- [x]`), and the last commit subjects.
- **% done** = done units / all units, where units are checklist boxes plus roadmap rows. It is computed at dusk
  (`snapshot.json`) and on demand from the night branch if it exists, else the base branch. **% won** = now minus
  dusk. A project with no units shows items done instead of a percentage.
- **Planner**: the candidates above go to one headless Claude session with read-only tools and a JSON answer,
  which is validated and retried once. It keeps only work that needs no decision from the owner, and writes each
  item as `{project, title, why, doneWhen, source}`. Anything that needs approval, sending, buying, an account,
  a design or copy choice, or a person outside is left out. When open items fall below twice the session count,
  the conductor plans again; when a project's plan runs out, the next project's turn comes, and every project
  always has evergreen work (tests, accessibility, error states, docs, performance), each item saying why.
- Order: Doing before Planned before Paused, then the order the owner set in the pane.

### 6.5 Workers

- `night-worker@<n>.service`, n from 1 to the session count, `Restart=always`, `MemoryHigh=5G`, `MemoryMax=6G`.
  The memory cap applies to everything the worker starts, tests included.
- A worker claims (under a lock) the next open item of a project no other worker holds and no busy desktop session
  works in. It works in `~/.claude/tacos/night/worktrees/<project>` on the branch `night/<date>/<project>`, cut
  from the base branch the first time.
- It runs `claude -p --permission-mode bypassPermissions --settings <guard settings> --strict-mcp-config
  --output-format stream-json --verbose --session-id <uuid>` (or `--resume <id>` for the next item of the same
  project), stdin `/dev/null`, with the night rules appended to the system prompt: never ask, take the
  conservative option and write it to `DECISIONS.md`, commit after each unit, tick the plan's box, heavy tests run
  under a lock, and end each item with `NIGHT-RESULT: done|partial|needs-owner · <one line>`.
- On exit it reads the result: `done` and `partial` close or reopen the item; `needs-owner` parks it with its
  question; a usage limit marks the worker limited until `resetsAt` and the same session is resumed after it; a
  crash or kill resumes the same session with "continue, check `git status` first".
- While Claude runs the worker beats every 30 s and stops a child that has written nothing for 20 minutes; the
  medic restarts a worker whose own beat is older than three minutes.

### 6.6 Guard

`bin/guard.mjs`, a PreToolUse command hook in the worker's `--settings`. Pure `decide(tool, input, ctx)`:

- **Denied Bash**: any `git push`; `git merge`, `rebase`, `reset`, `checkout` or `switch` onto a protected
  branch; `git worktree remove`; `gh` except read-only `view`, `list`, `status`, `diff`; `npm`/`pnpm`/`yarn
  publish`; deploy CLIs (`vercel`, `wrangler deploy|publish`, `firebase deploy`, `netlify deploy`, `supabase` against
  a remote, `fly deploy`); `sudo`, `pkexec`, `su`; `systemctl` except `--user` reads; `crontab`; `pkill`,
  `killall`; `curl`/`wget` sending data to a host that is not local; nested `claude`; `rm` of a path outside the
  worktree and the worker's scratch folder.
- **Denied tools**: Write, Edit and NotebookEdit outside the worktree and scratch; anything touching
  `~/.claude/settings*`, `~/.ssh`, `~/.config/systemd`, credential files; Artifact, CronCreate, CronDelete,
  RemoteTrigger, PushNotification, ScheduleWakeup and session-starting tools. Workers start with no MCP server at
  all, so mail, calendar, browser and database tools do not exist for them.
- **Rewritten**: a heavy test command (`npm|pnpm|yarn test`, `npx vitest|playwright|jest`, `pytest`, `cargo
  test`, `go test`, a `tests/run.sh`) runs as `flock <night lock> sh -c '<command>'`, one at a time across workers.
- Every deny and rewrite is an event. Shell parsing is best effort; the list in the README says so.

### 6.7 Watchers

Each is its own service with a heartbeat. Verdicts are pure functions of samples.

- **health** (30 s): swap over 95 % used is a blocker; memory pressure `full` avg60 over 5 % is thrash; free
  space under 8 GB warns and under 3 GB is a blocker; `/tmp` over 75 % blocks heavy tests; CPU over 85 °C or GPU
  junction over 100 °C activates the Day fan mode. Under a blocker or thrash it freezes the newest worker
  (`systemctl --user freeze`), one more every two minutes while it lasts, and thaws them in reverse once clear. No
  item starts while a blocker stands.
- **logs**: follows the user journal for night units and the system journal at priority err; classifies unit
  failures, OOM kills, segfaults and core dumps; de-duplicates by message for ten minutes.
- **usage**: from `usage-cache.json` and transcript limit records, writes when the five-hour or weekly gauge is
  exhausted and when it resets. Workers wait until a minute after the reset. There is no stop line.
- **medic** (60 s): classifies every live session (working, idle, limited, waiting and on what, hung, dead) into
  `sessions.json`; restarts a worker whose beat is stale; restarts a watcher whose beat is stale; re-runs a failed
  dusk or dawn step; writes each desktop session that waits on a dialog into the recap's one line, and never
  answers it.
- **keeper** (a timer, every two minutes and one minute after boot): if a night is in progress and `night.target`
  or the medic is down, starts them. This is what brings a night back after a reboot inside the window.

### 6.8 Recap

- `recap.json` from: `git log --all` per project since dusk (commits per hour, per project, lines added and
  removed), the queue's results and each worker's `NIGHT-RESULT` lines, desktop sessions' commits on their
  branches, % done at dusk and now, and the events.
- `recap.html`, one calm page: a row of four numbers (commits, lines, items done, sessions), then one line per
  project ("Slait site, 40 % to 58 %, +18"), then commits per hour across the night, commits per project, and per
  session at most two lines (what it did, which branch). Health is one line unless something happened. What needs
  the owner is one short line at the bottom, never a list or a card.
- Written every hour for the pane, and at dawn and on Stop. At dawn and on Stop a headless `claude -p --model
  haiku` reads the configured artifact and publishes the page to the same URL; the first publish creates it and
  stores the URL. If publishing fails, the pane and the local file still carry it.

### 6.9 Pane

`/night` opens a pane with three tabs. **Tonight**: the phase and window, each worker's project, item and state,
the watchers' beats, the queue's length, usage; buttons Arm or Disarm, Start now, Stop. **Recap**: the last recap.
**Settings**: from and to, the session count, the projects with their ticks, and the fan token's state. The mod
calls `node bin/night.mjs` through `$.process.run` and keeps the JSON it prints in atoms, as reflect does; the
engine never needs the pane.

## 7. Testing

- Unit tests for every pure module with `node:test`, made-up fixtures only (public repo), injected clocks,
  runners and paths; no test touches the real machine.
- A fake CoolerControl server for the pump rule; a fake `claude` script for the worker loop (writes stream-json,
  ends with a result, can be told to crash, hang or hit a limit); temporary git repos for worktrees and progress.
- Mod tests with `claude plugin test`.
- **Bulletproof checks on the real machine**: kill every service with SIGKILL and see its beat back within 30 s;
  kill a worker's Claude mid-item and see the same session resume; stop `night.target` and see the keeper bring it
  back; fake a full swap and a pressure spike and see a freeze and a thaw; fake a limit record and see the wait.
- A real short night: a 20-minute window, two workers, dusk and dawn, a recap.
