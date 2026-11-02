import type { Board, BoardRunReport, Card, Column } from "./board.ts";

/** The page reloads itself this often, so a Ticket's progress shows without touching it. */
const RELOAD_MS = 30_000;

const STATUS_WORDS: Record<NonNullable<Card["status"]>, string> = {
  building: "Building",
  reviewing: "In Review",
  waiting: "Waiting on a rate limit",
  passed: "Passed",
  parked: "Parked, waiting for you",
  "not-passed": "Not passed",
  blocked: "Waiting for a blocker",
};

const STYLE = `
:root {
  color-scheme: light dark;
  --page: #ffffff; --text: #1f2328; --muted: #57606a; --card: #ffffff; --line: #d0d7de; --link: #0550ae; --alert: #a40e26;
  --decision: #0969da; --decision-tint: #ddf4ff; --automatic: #1a7f37; --automatic-tint: #dafbe1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d1117; --text: #e6edf3; --muted: #9da7b3; --card: #161b22; --line: #3d444d; --link: #79c0ff; --alert: #ff9492;
    --decision-tint: #0b2a55; --automatic-tint: #0b3018;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 1rem; background: var(--page); color: var(--text); font: 1rem/1.45 system-ui, sans-serif; }
h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
a { color: var(--link); }
.note { margin: 0 0 1rem; color: var(--muted); }
.alert { color: var(--alert); font-weight: 600; }
.pipeline { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(15rem, 1fr); gap: .75rem; overflow-x: auto; padding-bottom: .5rem; }
.column { border-radius: .5rem; min-width: 0; }
.column.decision { background: var(--decision-tint); }
.column.automatic { background: var(--automatic-tint); }
.column header { padding: .5rem .75rem; border-radius: .5rem .5rem 0 0; color: #ffffff; }
.column.decision header { background: var(--decision); }
.column.automatic header { background: var(--automatic); }
.column h2 { margin: 0; font-size: 1.1rem; }
.column header p { margin: 0; font-size: .875rem; }
.cards { display: grid; gap: .5rem; padding: .5rem; }
.empty { margin: 0; padding: .25rem; color: var(--text); font-size: .875rem; }
.card { min-width: 0; padding: .625rem; border: 1px solid var(--line); border-radius: .375rem; background: var(--card); overflow-wrap: anywhere; }
.card h3 { margin: 0 0 .25rem; font-size: 1rem; }
.card p { margin: .25rem 0 0; font-size: .875rem; }
.card details { font-size: .875rem; white-space: pre-line; }
.card .meta { color: var(--muted); }
.card .failing { color: var(--alert); font-weight: 600; }
.reports { margin-top: 1rem; }
.reports h2 { margin: 0 0 .5rem; font-size: 1.25rem; }
.reports .card { margin-bottom: .5rem; }
.card .next { padding-top: .375rem; border-top: 1px solid var(--line); font-weight: 600; }
@media (max-width: 48rem) {
  .pipeline { grid-auto-flow: row; grid-auto-columns: auto; overflow-x: visible; }
}
`;

/** Turns each resume time into the Builder's own time zone, which a Codespace's server does not know. */
const LOCAL_TIMES = `for (const time of document.querySelectorAll("time")) time.textContent = new Date(time.dateTime).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });`;

/** Reloads, unless the Builder is reading a whole reason or is on a link: a reload would take that away from them. */
const RELOAD = `setInterval(() => { if (!document.querySelector("details[open]") && document.activeElement === document.body) location.reload(); }, ${RELOAD_MS});`;

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function capitalised(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The reason's first line, with the rest (a test's output, a list of failures) one tap away. */
function reasonOf(reason: string): string {
  const [first = "", ...rest] = reason.trim().split("\n");
  const more = rest.join("\n").trim();
  return `<p class="reason">${escape(first)}</p>${more ? `<details><summary>The whole reason</summary>${escape(more)}</details>` : ""}`;
}

function statusOf(card: Card): string {
  if (!card.status) return "";
  const resume = card.status === "waiting" && card.resumeAt ? `, resumes at <time datetime="${escape(card.resumeAt)}">${escape(card.resumeAt)}</time>` : "";
  return `<p class="status">${STATUS_WORDS[card.status]}${resume}</p>`;
}

function cardHtml(card: Card): string {
  const attempts = card.attempts === undefined ? "Attempts not known here: parked on another machine" : `${card.attempts} ${card.attempts === 1 ? "attempt" : "attempts"}`;
  const failing = card.failingChecks.length > 0
    ? `<p class="failing">Failing Review ${card.failingChecks.length === 1 ? "check" : "checks"}: ${card.failingChecks.map(escape).join(", ")}</p>`
    : "";
  return `<article class="card">
<h3><a href="${escape(card.url)}">#${card.number}</a> ${escape(card.title)}</h3>
<p class="meta">${attempts}</p>
${statusOf(card)}${failing}${card.reason ? reasonOf(card.reason) : ""}
<p class="next">Next: ${escape(card.nextAction)}</p>
</article>`;
}

function columnHtml({ stage, kind, cards }: Column): string {
  const body = cards.length > 0 ? cards.map(cardHtml).join("\n") : `<p class="empty">Nothing here.</p>`;
  return `<section class="column ${kind}" data-stage="${stage}" aria-labelledby="stage-${stage}">
<header><h2 id="stage-${stage}">${capitalised(stage)}</h2><p>${kind === "decision" ? "Decision stage: waits for you" : "Automatic stage: runs by itself"}</p></header>
<div class="cards">${body}</div>
</section>`;
}

function reportHtml({ spec, title, url, finishedAt, summary, details }: BoardRunReport): string {
  const name = url ? `<a href="${escape(url)}">Spec #${spec}</a>` : `Spec #${spec}`;
  return `<article class="card">
<h3>${name}${title ? ` ${escape(title)}` : ""}</h3>
<p class="meta">Finished at <time datetime="${escape(finishedAt)}">${escape(finishedAt)}</time></p>
<p>${escape(summary)}</p>
${details ? `<details><summary>The whole Run report</summary>${escape(details)}</details>` : ""}
</article>`;
}

function reportsHtml(reports: BoardRunReport[]): string {
  if (reports.length === 0) return "";
  return `<section class="reports" aria-labelledby="run-reports">
<h2 id="run-reports">Latest Run reports</h2>
${reports.map(reportHtml).join("\n")}
</section>`;
}

/** The board as one self-contained page; `problem` says why there is nothing to show. */
export function renderBoard(board: Board, now: Date, problem?: string): string {
  const empty = board.columns.every((column) => column.cards.length === 0);
  const unstaged = board.withoutStage.length > 0
    ? `<p class="note">Open, but without a Stage label, so in no column: ${board.withoutStage.map((issue) => `<a href="${escape(issue.url)}">#${issue.number}</a> ${escape(issue.title)}`).join("; ")}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Board</h1>
${problem ? `<p class="note alert">${escape(problem)}</p>` : `<p class="note">${empty ? "Nothing is open yet. Ask your Agent CLI to use the request skill to bring your first idea." : `Read at <time datetime="${now.toISOString()}">${now.toISOString()}</time>. This page updates itself.`}</p>`}
${unstaged}
${board.columns.length > 0 ? `<div class="pipeline" role="region" aria-label="The Pipeline, one column per Stage" tabindex="0">\n${board.columns.map(columnHtml).join("\n")}\n</div>` : ""}
${reportsHtml(board.runReports)}
</main>
<script>${LOCAL_TIMES}
${RELOAD}</script>
</body>
</html>
`;
}
