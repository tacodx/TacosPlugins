# night

Night mode for Claude Code on a Linux machine you leave on. You set a window,
say 23:30 to 06:30, and arm it. At the start of the window the machine goes
dark and quiet and up to four Claude Code sessions work through a queue built
from your own plans, each in its own git worktree, until you stop them. Small
watchers bring back anything that dies. At the end of the window the machine
comes back and a recap is waiting: what each session did, and per project how
far it got.

It is not made by or affiliated with Anthropic.

## What it needs

- **Linux with systemd user services**, and lingering on for your user
  (`loginctl show-user $USER -p Linger`), so the services run with no window
  open. Built and tested on Fedora (Nobara) with KDE Plasma on Wayland.
- **Claude Code**, logged in. Night uses the newest copy it finds: the desktop
  app's own, else `claude` on your `PATH`.
- **Node 22 or newer.**
- **A Claude Code that runs mods**, for the `/night` pane (2.1.287 or newer in a
  terminal, 2.1.286 or newer in the desktop app). The engine itself does not
  need the pane.
- **git**, and your projects in git repositories.
- Optional: `sensors` (lm_sensors) for temperatures and the pump check,
  CoolerControl for fan modes, power-profiles-daemon, and any command that
  switches your lights off and on.

## Install

```
claude plugin marketplace add tacodx/TacosPlugins
claude plugin install night@tacos-plugins
```

Then, once, from the plugin's folder:

```
node bin/night.mjs install
node bin/night.mjs doctor
```

`install` writes the systemd user units and turns on a keeper timer. `doctor`
says what is set and what is missing.

## Using it

Type `/night`. The Settings tab takes the window, the number of sessions (one
to four) and which projects may be worked on. The Tonight tab has **Arm**,
**Start now** and **Stop**, and shows each session, the queue and the
watchers while a night runs. The same commands work in a terminal, from the plugin's folder:
`node bin/night.mjs set 23:30 06:30`, then `arm`, `start`, `stop` or
`status` in place of `set`.

A night only runs when you arm it. Stop is the only thing that ends the
sessions: at the end of the window the machine comes back and the recap is
written, and the sessions keep working until you press Stop.

## Where the work comes from

Night reads plans you already keep. In `~/.claude/tacos/night/config.json`:

- `sources.notesDir`: a folder of Markdown notes, one per project, with
  frontmatter `status`, `area` and `where` (the path of the project). Notes in
  Doing, Planned or Paused that point into a git repository are open projects;
  the `Client` area is left out by default.
- `sources.roadmaps`: Markdown files with tables whose rows a note named
  "Session X ..." stands for. A struck row is done.
- `sources.planGlobs`: plan files in each repository with `- [ ]` checklists.

For each project a planner (one Claude call with no tools) maps the plan into
tasks, judges which are done, and picks up to six items that need no decision
from you, each with the reason it exists. When the queue runs low it plans the
next project. Items that turn out to need you are parked, and the session moves
on.

**% done** is the share of a project's mapped tasks that are done. The map is
frozen when the project is first planned that night; **% won** is how far that
share moved by morning.

## What a night session may do, and what it cannot

Each session is a headless Claude Code run with
`--permission-mode bypassPermissions`, so it never stops on a dialog. Four
walls hold it:

1. **Claude's Bash sandbox.** The file system is read-only outside the
   session's worktree, its scratch folder and the package caches.
2. **Pushes fail in git itself.** Every push URL is rewritten to a host that
   does not exist, and `gh` gets a token that does not work.
3. **A guard hook** (`bin/guard.mjs`) denies, among others: any `git push`,
   switching to or rewriting a protected branch, `gh` writes, publishing,
   deploy tools, `sudo`, `systemctl` changes, sending mail, writes outside the
   worktree, reading key files, and every tool that would publish, schedule or
   start another session. Heavy test and build commands are rewritten to run
   one at a time under a lock. The hook fails closed.
4. **No MCP servers and none of your user settings.** Sessions start with
   `--strict-mcp-config --setting-sources project,local`, so your user hooks,
   plugins, skills and connectors (mail, calendar, browser) do not exist for
   them.

Before any session starts, a canary checks that the hook denies a push and
that git cannot push. If either fails, no session starts and the recap says so.

Work lands on local branches named `night/<date>/<project>`, cut from the
branch where you last worked in that repository. Nothing is merged or pushed.

## The machine at night

At the start of the window, each step on its own: sleep is blocked (screens
may still go dark), the power profile is held at power-saver, CoolerControl is
switched to a mode named Night, your lights-off command runs, and the screens
are switched off. At the end, the reverse, except that sleep stays blocked
until Stop.

**Fans.** Night never edits a fan curve. You make two modes in CoolerControl,
Day (your normal setup) and Night (quieter), and save a CoolerControl access
token to the file named in `hardware.fans.tokenFile`. Before switching, night
reads the mode and refuses it unless the pump channel
(`hardware.fans.pumpChannel`, on `hardware.fans.pumpDevice`) is a fixed duty of
at least 50 %. After switching it reads the pump's speed; under
`hardware.fans.pumpMinRpm` it switches back to Day. The health watcher reads
the pump every 30 seconds, and if it stays low every session is paused.

## The watchers

Each is its own service with a heartbeat:

- **health**: a full swap or a nearly full disk stops new work; memory pressure
  pauses the session using the most memory, and the next one two minutes later
  if it lasts; heat switches the fans to Day.
- **logs**: unit failures, out-of-memory kills, segfaults and core dumps from
  the journal.
- **usage**: when a usage limit hits, sessions wait until a minute after the
  reset and go on. There is no stop line.
- **medic**: looks at every Claude Code session on the machine. It restarts a
  night session or a watcher that stopped beating, re-runs a failed dusk or
  dawn step, and writes down any session waiting on a dialog. It never answers
  a dialog and never resumes your own sessions (the desktop app resumes those
  after a limit itself).
- **keeper**, a timer every two minutes and after boot, restarts the medic and
  brings a night back after a reboot inside the window.

## The recap

At the end of the window and at Stop, `recap.html` is written: the night's
commits, lines and items, one line per project with its % at dusk and now,
commits per hour and per project, a line or two per session, health in one
line, and one short line for what needs you. It is published to one private
claude.ai artifact (by a headless Claude that has only the Artifact tool),
whose link the pane shows, and kept under the night's folder.

## What it reads and what it writes

It reads: your notes, roadmaps and plan files; your repositories (git log,
branches, files on a branch); `~/.claude/sessions/` and the ends of
transcripts in `~/.claude/projects/`; `~/.claude/tacos/usage-cache.json`
(written by usage-guard, if you have it); `/proc`, `sensors -j` and the
journal.

It writes:

- `~/.claude/tacos/night/`: `config.json`, `current.json`, and one folder per
  night under `nights/<date>/` (queue, events, heartbeats, recap).
- `~/.local/share/night/`: the worktrees and scratch folders of each night.
  Clean worktrees are removed at Stop; the branches stay.
- `~/.config/systemd/user/night*`: its units. `night uninstall` removes only
  files that start with night's own marker line.
- New commits on `night/<date>/<project>` branches in your repositories.

## What leaves your machine

The planner, the sessions and the recap publisher are Claude Code runs on your
own account, so they use your usage and send what they read to Anthropic, as
any Claude Code session does. The recap is published as a private artifact on
your account. Nothing else is sent anywhere.

## Limitations

- Linux and systemd only. The screen commands default to KDE Plasma; set
  `hardware.screens` for another desktop.
- The guard reads shell commands as text and cannot see inside every script;
  the sandbox and the push block are the walls that do not depend on it.
- A session can still spend your usage on work you would not have chosen. Items
  come only from your own plans, but the planner's judgement is a model's.
- The pump rule trusts CoolerControl's mode format as of 5.1.1. A mode it
  cannot read is refused, so an unknown format means the fans stay as they are.
- Commits made by your own desktop sessions overnight are counted in the
  recap, but night only knows what they did from their commits.
- Mods are an early-access feature of Claude Code and their API still changes.
