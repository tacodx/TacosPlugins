// The morning recap as one calm HTML page, for the private claude.ai artifact and the
// local recap.html. Pure: the recap object from data.mjs in, the page's text out.
//
// The artifact host wraps the page in its own document, so it starts at its <title>
// and brings everything inline: no script at all, no font or file from elsewhere.
// Every string that came from the night is escaped, because result lines, task titles
// and commit subjects are written by models and may hold markup.
//
// The order is the owner's: the headline, four numbers, one line per project, the
// three drawings, at most two lines per session, then health, usage and, last, the one
// line of what needs him. Never a list of events or a table of items.
import { CHART_CSS, OTHER, SERIES, esc, group, hourChart, legend, progressChart, projectChart } from './charts.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** Escaped text with a no-break space between a number and its %, so "58 %" never splits. */
const t = (value) => esc(value).replace(/(\d) %/g, '$1&nbsp;%')

const series = (mode) => SERIES[mode].map((hex, i) => `--s${i + 1}:${hex}`).join(';')

const DARK = `--bg:#10141b;--ink:#e8ebf0;--ink-2:#b3bac6;--ink-3:#8c94a3;--rule:#262d38;--axis:#3a4250;` +
  `--track:#1e242e;--dusk:#5e6777;--wash:rgba(232,235,240,.05);${series('dark')};--other:${OTHER.dark};color-scheme:dark`

const STYLE = `
/* One calm column on a cool night-blue neutral: headline, four figures, projects, three drawings, sessions, three quiet lines. */
:root{
  --bg:#f5f6f8;--ink:#12161d;--ink-2:#454c59;--ink-3:#636a78;--rule:#dde1e7;--axis:#c3c8d1;
  --track:#e3e6ec;--dusk:#858c9a;--wash:rgba(18,22,29,.04);${series('light')};--other:${OTHER.light};
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",Ubuntu,Cantarell,sans-serif;
  --mono:ui-monospace,"JetBrains Mono","SF Mono","Cascadia Mono","Noto Sans Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);-webkit-text-size-adjust:100%}
.page{box-sizing:border-box;max-width:44rem;margin-inline:auto;display:grid;gap:40px;
  padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px));padding-block:32px 56px}
.page > *{min-width:0}
p{margin:0}
h1{margin:6px 0 0;font-size:1.6rem;line-height:1.25;font-weight:620;letter-spacing:-.01em;text-wrap:balance;overflow-wrap:anywhere}
h2{margin:0 0 14px;font:500 .72rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.09em;color:var(--ink-3);
  display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between}
h2 .aside{text-transform:none;letter-spacing:0}
.eyebrow{font:500 .75rem/1.3 var(--mono);color:var(--ink-3);letter-spacing:.02em}
.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.figure{border-top:1px solid var(--rule);padding-top:10px;display:grid;gap:2px;min-width:0}
.figure .value{font-size:1.9rem;line-height:1.1;font-weight:600;letter-spacing:-.015em}
.figure .label{font-size:.8125rem;color:var(--ink-3);overflow-wrap:anywhere}
.rows{display:grid;gap:12px}
.row{display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}
.row .name{font-weight:600}
.row .won{font-weight:600;font-variant-numeric:tabular-nums}
.row .sub{font-size:.875rem;color:var(--ink-2)}
.drawings{display:grid;gap:36px}
.plain{color:var(--ink-2)}
.quiet{display:grid;gap:6px;border-top:1px solid var(--rule);padding-top:16px;font-size:.9375rem;color:var(--ink-2);overflow-wrap:anywhere}
.quiet .needs{color:var(--ink)}
.quiet .needs b{font-weight:600}
@media (max-width:560px){
  .page{gap:32px;padding-block:24px 48px}
  h1{font-size:1.35rem}
  .figures{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  .figure .value{font-size:1.6rem}
}
${CHART_CSS}`

function figures(totals) {
  const lines = num(totals.linesAdded)
  const items = [
    [group(num(totals.commits)), num(totals.commits) === 1 ? 'commit' : 'commits'],
    [`+${group(lines)}`, `lines added, ${group(num(totals.linesRemoved))} removed`],
    [group(num(totals.itemsDone)), num(totals.itemsDone) === 1 ? 'item done' : 'items done'],
    [group(num(totals.sessions)), num(totals.sessions) === 1 ? 'session' : 'sessions'],
  ]
  return `<section class="figures" aria-label="The night in four numbers">${items
    .map(([value, label]) => `<div class="figure"><span class="value">${esc(value)}</span><span class="label">${esc(label)}</span></div>`)
    .join('')}</section>`
}

// "harbor-site, 40 % to 58 %, +18" with the name and the points set apart; the words are data.mjs's own line.
function projectLine(p) {
  const name = String(p.name ?? '')
  const line = String(p.line ?? name)
  const rest = line.startsWith(name) ? line.slice(name.length) : `, ${line}`
  const tail = t(rest).replace(/, ([+-]\d+)$/, ', <span class="won">$1</span>')
  const sub = p.leftLine ? `<p class="sub">${t(p.leftLine)}</p>` : ''
  return `<div class="row"><p><span class="name">${esc(name)}</span>${tail}</p>${sub}</div>`
}

function sessionLines(s) {
  return (
    `<div class="row"><p><span class="name">${esc(s.name)}</span> ${t(s.did)}</p>` +
    `<p class="sub">${t(s.where)}</p></div>`
  )
}

function section(id, title, body, aside = '') {
  const side = aside ? `<span class="aside">${t(aside)}</span>` : ''
  return `<section aria-labelledby="${id}"><h2 id="${id}"><span>${esc(title)}</span>${side}</h2>${body}</section>`
}

function drawings(recap) {
  const totals = recap.totals ?? {}
  const measured = list(recap.projects).some((p) => typeof p?.duskPct === 'number' && typeof p?.nowPct === 'number')
  if (num(totals.commits) === 0 && !measured) {
    return '<p class="plain">No commits tonight, so there is nothing to chart.</p>'
  }
  const parts = []
  if (num(totals.commits) > 0) {
    parts.push(section('h-hours', 'Commits per hour', `${legend(recap)}${hourChart(recap)}`, recap.windowLabel ?? ''))
    const perProject = list(recap.perProject)
    parts.push(
      perProject.length > 1
        ? section('h-per-project', 'Commits per project', projectChart(recap))
        : section('h-per-project', 'Commits per project', `<p class="plain">All ${group(num(totals.commits))} commits went to ${esc(perProject[0]?.name ?? 'one project')}.</p>`),
    )
  } else {
    parts.push('<p class="plain">No commits tonight.</p>')
  }
  if (measured) parts.push(section('h-progress', 'Done at dusk and now', progressChart(recap)))
  return `<div class="drawings">${parts.join('')}</div>`
}

/** The page for one recap, as text. */
export function renderPage(recap = {}) {
  const totals = recap.totals ?? {}
  const projects = list(recap.projects)
  const sessions = list(recap.sessions)
  const running = recap.phase === 'dusk' || recap.phase === 'night'
  const eyebrow = [recap.windowLabel, recap.writtenAt ? `written ${recap.writtenAt}` : '', running ? 'still running' : '']
    .filter(Boolean)
    .join(' · ')

  const body = [
    `<header>${eyebrow ? `<p class="eyebrow">${t(eyebrow)}</p>` : ''}<h1>${t(recap.headline ?? 'Night recap')}</h1></header>`,
    figures(totals),
    projects.length > 0 ? section('h-projects', 'Projects', `<div class="rows">${projects.map(projectLine).join('')}</div>`) : '',
    drawings(recap),
    section(
      'h-sessions',
      'Sessions',
      sessions.length > 0 ? `<div class="rows">${sessions.map(sessionLines).join('')}</div>` : '<p class="plain">No session ran tonight.</p>',
    ),
    `<footer class="quiet">` +
      `<p>${t(recap.health ?? '')}</p>` +
      (recap.usageLine ? `<p>${t(recap.usageLine)}</p>` : '') +
      (recap.needsLine ? `<p class="needs">${t(recap.needsLine).replace(/^Needs you:/, '<b>Needs you:</b>')}</p>` : '') +
      `</footer>`,
  ]

  return (
    `<title>Night recap</title>\n` +
    `<meta name="claude:viewport-fit-sides" content="cover">\n` +
    `<style>${STYLE}\n</style>\n` +
    `<main class="page">${body.filter(Boolean).join('\n')}</main>\n`
  )
}
