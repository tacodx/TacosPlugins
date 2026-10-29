# board

A Claude Code mod that shows you the work going on, so you can see it is. Type
`/board` and a pane opens beside the conversation with today's commits, commits
per hour and per project, the sessions working right now and your plan. While
it is open it refreshes itself every few minutes.

Every number is computed on your machine from your git repos and from files
Claude Code already keeps. It is not made by or affiliated with Anthropic.

## What it shows

From top to bottom:

| Card | What is on it |
|---|---|
| Today | Commits today, lines added today, commits in the last 7 days |
| Commits per hour | The last 30 hours, one column per hour in one colour, so a quiet night shows as a gap |
| Commits per project | The last 7 days, one stacked column per day, each project in a colour it keeps |
| Working now | The sessions busy right now, by name, with the project each runs in and for how long |
| The plan | The rows of one table in a Markdown file you name: number, name, and status; struck-through rows are done |

There is a **Refresh now** button under the cards.

## What it needs

- **A Claude Code that runs mods.** Built with Claude Code 2.1.292, which its
  engine tests run on; earlier versions are untested. Mods are an early-access
  feature and their API still changes between releases.
- **Node 22 or newer and git on your `PATH`.** A mod cannot run git or read
  large files itself, so the reading is done by a small Node program that ships
  with the plugin.
- **The desktop app, for the charts.** The cards are SVG, which only the
  desktop Code tab draws. In a terminal `/board` shows the same numbers as text.

## Install

```
claude plugin marketplace add tacodx/TacosPlugins
claude plugin install board@tacos-plugins
```

Then type `/board`.

## Settings

The first run writes `~/.claude/tacos/board/config.json`:

```json
{
  "repos": ["~/Projects/*", "~/Projects/work/*"],
  "plan": null,
  "refreshMinutes": 3,
  "authors": []
}
```

- **`repos`**: the repos to count. A folder that is a git repo, or a folder
  followed by `/*` for every repo directly inside it. The first run lists
  `~/Projects/*`, plus `~/Projects/<folder>/*` for each folder there that holds
  repos of its own (the `work` line above is an example of one).
- **`plan`**: `{ "file": "~/path/to/ROADMAP.md", "section": "Next up" }`.
  The plan is the first table under the heading with those words, or the first
  table in the file when there is no `section`. A row's first cell is its
  number and its second its name; a bold phrase that opens the third cell is
  shown as its status, such as `**Started 2026-03-02.**`.
- **`refreshMinutes`**: how often an open pane refreshes, from 1 to 60.
- **`authors`**: whose commits count, by email. Left empty, a commit counts
  when its author is one of the identities your repos commit as (each repo's
  `user.email`, or your global one).

Changes take effect at the next refresh.

## What it reads and what it writes

It reads:

- **Your repos**, through `git show-ref` and `git log --all`. A repo whose refs
  have not moved since the last refresh is not read again.
- **The plan file**, if you name one.
- **`~/.claude/sessions/*.json`**, Claude Code's own list of the sessions
  running on this machine, for the sessions at work. It never opens the key
  files Claude Code keeps in the same folder.
- **`~/.claude/projects`**, only when that list cannot be read: then the
  sessions shown are the transcripts written to in the last ten minutes.

It writes to exactly one folder, `~/.claude/tacos/board/`:

- `config.json`, your settings, written once and then only read.
- `cache.json`, each repo's recent commits under a hash of its refs, and the
  colour each project was given. Delete it any time; projects may then change
  colour.

## What leaves your machine

Nothing. The board makes no network request and sends nothing to a model.

## What a mod can do, and what this one does

A mod runs inside Claude Code with your permissions. Before installing any mod
you can see what it hooks and calls without running it:

```
claude plugin validate <path to the plugin>
```

For this one that lists three hooks (`session.start`, to register the command
and start its timer; `command.run`, for `/board`; `ui.render`, to draw its own
pane) and these calls: `$.process.run` to run the reader, `$.clock` for the
timer, `$.ui` and `$.state` for the pane. It hooks no tool call and no prompt,
and never sees or changes your conversation.

## How things are counted

- **Commit.** One commit on any branch, tag or remote of a repo on the list,
  not counting the stash, made by one of your identities (see `authors`). A
  commit found in two repos, a clone and its original say, is counted once.
  Merges count; they add no lines of their own.
- **Lines added.** The lines git counts as added by today's commits, not
  counting lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock` and
  the like), which can add thousands of lines nobody wrote.
- **When.** A commit belongs to the hour and day of its author date, on your
  computer's clock and in its time zone.
- **A project's colour.** Each project with commits in the last 7 days gets one
  of eight colours and keeps it from refresh to refresh. A project that comes
  back after a quiet spell keeps its old colour unless another has taken it.
  Past eight projects at once, the ones with the fewest commits are grey and
  listed as Other.
- **Working now.** A session Claude Code lists as busy. Sessions that programs
  start through the SDK, such as claude-mem's observers, are left out.

## Limitations

- **The session list is Claude Code's own, not an API.** Its shape can change
  with any release; when it can no longer be read, the board falls back to
  transcripts written to in the last ten minutes and says so on the card.
- **Only work that ends in a commit is counted.** A session busy for an hour
  before its first commit shows under Working now, not in the charts.
- **Your identities are guessed from your repos.** A commit made under an email
  none of your repos uses, on GitHub's website for one, is not counted unless
  you list it under `authors`.
- **A rebase or amend moves commits.** The copies keep their author dates, so
  they land where the work was done, but the old ones are no longer on any
  branch and drop out of the count.
- **Charts need the desktop app.** There are none in a terminal, in VS Code or
  on mobile.
- **Mods are early access.** A Claude Code update can change the API this
  plugin is written against.
