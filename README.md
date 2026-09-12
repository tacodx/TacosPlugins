# TacosPlugins

A marketplace repo of Claude Code plugins. One repo, several independently
installable plugins, sharing code that gets vendored into each plugin at
release time.

## Plugins

| Plugin | What it does |
|---|---|
| [`usage-guard`](plugins/usage-guard/README.md) | Per-chat budgets enforced against your account's real rate-limit gauges (5-hour, weekly, extra usage, per-model). |
| [`model-advisor`](plugins/model-advisor/README.md) | Tells you whether switching models would actually help your current rate limits — informational only, never denies anything. |

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
│   └── model-advisor/
│       ├── .claude-plugin/plugin.json
│       ├── hooks/, commands/, bin/
│       └── lib/                      # vendored copy of packages/core (tracked in git)
└── scripts/release.mjs               # copies packages/core into every plugin's lib/
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
`packages/core/`, and `scripts/release.mjs` copies it into every plugin's
`lib/` directory before release.

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
