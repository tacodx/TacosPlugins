# TacosPlugins

A marketplace repo of Claude Code plugins. One repo, several independently
installable plugins, sharing code that gets vendored into each plugin at
release time.

## Plugins

| Plugin | What it does |
|---|---|
| [`usage-guard`](plugins/usage-guard/README.md) | Per-chat budgets enforced against your account's real rate-limit gauges (5-hour, weekly, extra usage, per-model). |
| [`model-advisor`](plugins/model-advisor/README.md) | Tells you whether switching models would actually help your current rate limits — informational only, never denies anything. |
| [`reflect`](plugins/reflect/README.md) | `/reflect` opens a pane that charts how you use Claude Code: activity, projects, models and tools, computed from your local history. A mod, so it needs Claude Code 2.1.287 or newer. |
| [`night`](plugins/night/README.md) | Night mode: arm a window and up to four Claude Code sessions work through a queue built from your own plans while the machine is dark and quiet, behind a sandbox, a push block and a guard hook; watchers bring back anything that dies, and a recap waits in the morning. Linux with systemd; the `/night` pane is a mod. |
| [`board`](plugins/board/README.md) | `/board` opens a pane that shows the work going on: commits per hour and per project, the sessions working now and your plan, refreshed every few minutes. A mod, so it needs Claude Code 2.1.292 or newer. |

## Installation

```
claude plugin marketplace add tacodx/TacosPlugins
```

Then install whichever plugin you want, e.g. `usage-guard`, from the
marketplace listing.

## Repository layout

```
TacosPlugins/
├── .claude-plugin/marketplace.json   # marketplace manifest
├── packages/core/                    # shared code — the source of truth
├── plugins/
│   ├── usage-guard/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/, commands/, bin/
│   │   └── lib/                      # vendored copy of packages/core (tracked in git)
│   ├── model-advisor/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/, commands/, bin/
│   │   └── lib/                      # vendored copy of packages/core (tracked in git)
│   ├── reflect/                      # a mod; standalone, so no lib/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/                    # the mod: pane, tabs, charts
│   │   ├── indexer/                  # the Node program that reads the history
│   │   └── types/, test/
│   ├── night/                        # systemd services and a mod; standalone, so no lib/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── bin/                      # night.mjs (the CLI the units call) and guard.mjs (the worker hook)
│   │   ├── engine/                   # queue, planner, workers, watchers, dusk and dawn, recap
│   │   ├── hooks/                    # the mod: the /night pane
│   │   └── types/, test/
│   └── board/                        # a mod; standalone, so no lib/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/                    # the mod: pane, cards
│       ├── reader/                   # the Node program that reads git, sessions and the plan
│       └── types/, test/
└── scripts/release.mjs               # copies packages/core into each plugin that uses it
```

## Development

Node 22+, plain ESM (`.mjs`), no build step, zero runtime or dev dependencies.

Run the test suite:

```
npm test
```

### The vendoring rule

Each plugin ships as a self-contained directory — Claude Code does not run
`npm install` for a plugin, and a plugin cannot import from a sibling
`packages/core/` at runtime. So the shared code lives once, in
`packages/core/`, and `scripts/release.mjs` copies it into the `lib/`
directory of every plugin that uses it before release. A plugin that imports
nothing from `packages/core/` is named in `STANDALONE_PLUGINS` there and
carries no `lib/`.

**`plugins/*/lib/` is generated but tracked in git, not gitignored** — a
plugin installs as a self-contained directory with no build step, so the
vendored copy actually committed is what ships; nothing regenerates it at
install time. Never edit a file under `plugins/*/lib/` directly — it will be
silently overwritten (and any file in there with no matching source in
`packages/core/` gets deleted) the next time release runs. Always edit
`packages/core/`, then regenerate and commit the result:

```
node scripts/release.mjs
```

Run this before testing a plugin end-to-end and before every release. A test
(`packages/core/test/release.test.mjs`) fails the build if a plugin's `lib/`
ever drifts from `packages/core/` in a commit.
