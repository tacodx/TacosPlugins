# reflect

A Claude Code mod that shows you how you use Claude Code. Type `/reflect` and a
pane opens beside the conversation with your activity, projects, models and
tools as charts, for the last 7, 30 or 90 days or for all time.

Every number is computed on your machine from history Claude Code already
keeps. It is not made by or affiliated with Anthropic, and it is a different
thing from the Reflect dashboard in the Claude chat apps.

## What it shows

| Tab | What is on it |
|---|---|
| Overview | Prompts, sessions, output tokens, busy time, streak, cache hit rate, subagent share and tool calls; output tokens over time; a weekday-by-hour grid of when you prompt; your top projects and models |
| Activity | A calendar of prompts per day, prompts and sessions over time, your longest sessions |
| Projects | Every project ranked by output tokens, by prompts and by sessions started |
| Models | Each model's share of output and of replies, output over time by model, how much was read from the prompt cache, effort levels |
| Tools | The tools Claude used most, the skills it loaded, the MCP servers it called |
| Work | The mix of work (features, fixes, discoveries, …) by month and by project. Needs the claude-mem plugin; see below |
| Tips | A few plain observations read off the numbers and, if you ask for them, a few suggestions written by a model |

## What it needs

- **A Claude Code that runs mods.** In a terminal, version 2.1.287 or newer. In
  the Claude desktop app, a Code tab whose bundled Claude Code is 2.1.286 or
  newer (`/status` shows it). Mods are an early-access feature and their API
  still changes between releases; this plugin was built and tested on 2.1.289
  and 2.1.292.
- **Node 22 or newer on your `PATH`.** A mod cannot read large files itself, so
  the reading is done by a small Node program that ships with the plugin.
- **The desktop app, for the charts.** The pane's drawings are SVG, which only
  the desktop Code tab draws. In a terminal `/reflect` shows the totals as text.
- **Optionally, [claude-mem](https://github.com/thedotmack/claude-mem) and the
  `sqlite3` command**, for the Work tab. Without them that tab says so and the
  rest works.

## Install

```
claude plugin marketplace add tacodx/TacosPlugins
claude plugin install reflect@tacos-plugins
```

Then type `/reflect`. The first time takes about twenty seconds for a few
gigabytes of history; after that a fraction of a second.

## What it reads and what it writes

It only reads Claude Code's own files:

- `~/.claude/projects/**/*.jsonl`, the transcripts of your sessions and their
  subagents. This is where prompts, sessions, tokens, tools and models come from.
- `~/.claude/history.jsonl`, the prompts typed in terminal sessions. It covers
  the months before your oldest surviving transcript.
- claude-mem's database, opened read-only, for the Work tab.

It writes to exactly one folder, `~/.claude/tacos/reflect/`:

- `store.json` holds a summary per transcript and a running total.
- `store.lock` exists while a session is updating the summary.
- `store.corrupt-<time>.json` is a store that could not be read, kept aside
  when it had to be rebuilt.

The summary is why this plugin can show more than a month. Claude Code deletes
transcripts after thirty days by default. When one is deleted, its numbers stay
in the running total. Delete the folder to start over; you will lose whatever
history is older than the transcripts still on disk.

## What leaves your machine

Nothing, unless you press **Write suggestions** on the Tips tab.

Pressing it sends one request to Claude Haiku through your own Claude Code
account, which uses a little of your usage; the pane shows how many tokens. The
request contains numbers only: totals, the weekday and hour you are busiest,
model, tool and skill names, and per-project figures in which **project names
are replaced by placeholders** (`project-1`, `project-2`, …). **Session titles
are left out**, and no prompt or reply text is ever read for this. The real
names are put back into the answer on your machine.

Everything else on the Tips tab, and every other tab, is arithmetic done
locally.

## What a mod can do, and what this one does

A mod runs inside Claude Code with your permissions. Before installing any mod
you can see what it hooks and calls without running it:

```
claude plugin validate <path to the plugin>
```

For this one that lists three hooks (`session.start`, to register the command;
`command.run`, for `/reflect`; `ui.render`, to draw its own pane) and these
calls: `$.process.run` to run the indexer, `$.model.complete` for the Tips
button, `$.store` to remember the suggestions it wrote today, `$.state` and
`$.ui` for the pane. It hooks no tool call and no prompt, and never sees or
changes your conversation.

## How the numbers are counted

- **Prompt.** A message you typed in a main session. Slash commands, tool
  results and the messages subagents receive are not prompts.
- **Session.** One main transcript. A session counts toward a range if it
  started in it.
- **Output tokens.** For each reply, the final figure Claude Code recorded.
  Replies written by subagents are included, and are most of the total for
  anyone who uses them much.
- **Busy time.** The time a session was at work: gaps of under five minutes
  between consecutive prompts and replies, added up. It includes Claude working
  while you were away, so it is not the time you spent typing.
- **Cache hit rate.** Tokens read from the prompt cache, as a share of all
  tokens Claude read.
- **Streak.** Consecutive days with at least one prompt. A day that has only
  just begun does not break it.

Days and hours are in your computer's time zone.

## Limitations

- **History starts where your transcripts do.** Tokens, tools, models and
  sessions are known only for transcripts that still existed the first time
  this plugin ran. Earlier months show prompts only, and only those typed in a
  terminal.
- **Charts need the desktop app.** There are none in a terminal, in VS Code or
  on mobile.
- **A few replies are counted twice.** A resumed session copies some earlier
  records into its new transcript in a way that cannot be told apart cheaply.
  On the machine this was built on that is 46 of about 76,000 replies.
- **A project folder renamed while its session is running** leaves that
  session's transcript in two pieces, and only the larger is counted. The pane
  says when a transcript exists in more than one place. A transcript restored
  from a backup after Claude Code deleted it is counted again.
- **Changing your time zone** makes the next run re-read every transcript.
  Days already in the running total stay in the zone they were counted in.
- **The Work tab is only as good as claude-mem's notes**, and its project names
  are claude-mem's, which can differ from the ones on the Projects tab.
- **Mods are early access.** A Claude Code update can change the API this
  plugin is written against.
