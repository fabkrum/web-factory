# web-factory

An agentic website factory: from request to measured live site, with the ticket loop doing the build and review on Gemini, Claude or OpenAI.

## License

MIT, see [LICENSE](LICENSE).

## Start a Site

There are two ways in, and both end in the same Site repository. Choose the Codespace if you are on Windows or a Chromebook, want to try things quickly, or do not want to install anything: it runs in your browser, but it stops when it sits idle and uses up your free GitHub hours, so it does not suit a Ticket loop that runs overnight. Choose the local install if you have a Mac, Linux or Windows with WSL and want to leave a Ticket loop running overnight: your own computer has to stay on, but nothing stops it and no hours run out.

Native Windows is not supported in v1. On Windows, use the Codespace, or install WSL and follow the local install inside it.

### In a Codespace

Open the [template](https://github.com/fabkrum/web-factory-template), press **Use this template**, then **Create a new repository**. In your new repository press **Code**, then **Codespaces**, then **Create codespace**. Git, Node, the GitHub CLI, all four Agent CLIs and the tools Claude Code's sandbox runs on are already there, and the Site's first install runs by itself.

### On your own computer

```sh
curl -fsSL https://raw.githubusercontent.com/fabkrum/web-factory/main/install.sh | sh -s -- my-site
```

This one command asks which Agent CLI you use, with no default. It then installs whatever is missing of git, Node, the GitHub CLI and that Agent CLI (for Claude Code on Linux and WSL, also bubblewrap and socat, the tools its sandbox runs on), and creates your Site in the folder `my-site`. Node and the GitHub CLI go into `~/.web-factory`, so they need no administrator password; on Linux, git, bubblewrap and socat may ask for one. It ends by telling you what to do next.

It is safe to run again. If an earlier run stopped halfway, the same command notices, repairs what was left and finishes the job. If everything is already there, it changes nothing.

If you already have Node 22.19 or later and git, this does the Site part alone:

```sh
npm create web-factory@latest my-site
```

### What each Agent CLI costs

As of 2026-11-02. These offers change often, so check the provider's own pricing page before you pay for anything.

| Agent CLI | What you need | What it costs | Good to know |
| --- | --- | --- | --- |
| Antigravity CLI | A free Google account | Free | Google does not publish its weekly limit, so a long Ticket loop may have to wait for it. |
| Codex | ChatGPT Free or Go | Free, or about $8 a month for Go | Limited use, and OpenAI may change it. Paid plans from Plus upward raise the limits. |
| Claude Code | Claude Pro, or a paid API key | $20 a month, or pay per use with the key | There is no free plan. |
| Gemini CLI | A paid API key | Pay per use | Free Google accounts lost access on 2026-06-18; use Antigravity CLI with those. |

### What you get

This creates a Site repository in `my-site`: the Factory pinned as a dependency with its `factory` command, one AGENTS.md, the shared skills folder `.agents/skills`, and Modern Web Guidance vendored there at a pinned version with its licence and notice. Claude Code reaches the same instructions and skills through a CLAUDE.md that imports AGENTS.md and the link `.claude/skills`; Gemini CLI through `.gemini/settings.json`. Running the command again adds only what is missing, so it finishes a run that was cut short and changes nothing in a finished Site.

## Kickoff

Before the first Request, the `kickoff` skill in the Site's `.agents/skills` guides the Builder: who the Site is for, what it must do, how often its content changes, where its operator and Visitors are, and which Agent CLI they use (there is no default). It recommends a stack and a host with the case for and against each option, the Builder decides, and it sets up the chosen stack. It then writes the decisions to a file and runs `factory kickoff <decisions-file>`, which records them and commits: `docs/adr/0001-stack.md` and `docs/adr/0002-host.md` with every option offered, the Stack section in AGENTS.md, and `agentCli`, `host`, `testCommand`, `buildCommand`, `serveCommand` and `localePack` in `factory.json`. An operator or Visitors in Germany switch the German Locale pack on. Last it creates the Stage labels on GitHub. If GitHub cannot be reached the record stays, and running the same command again finishes it; once recorded, different decisions are refused, because a change to the architecture is a new Architecture decision in a Spec. Firebase is the only host the Factory connects itself; for any other host the decisions must carry that host's own setup (`host.setup`), which is recorded and shown as the Builder's next step, so it may hold no line starting with `## `.

## Request and Spec

A Builder describes an idea or a bug in their own words; the `request` skill writes it to a file and runs `factory request <request-file>`, which files it as an issue in the Request Stage. Before any GitHub login, the command says why a login is needed now and changes nothing; running it again afterwards files the Request.

The `spec` skill questions the Builder until the Request is precise, agrees how to tell that the Site does what it should, and cuts the work into thin vertical Tickets, splitting any it judges too big for one session. `factory spec <spec-file>` then makes the Request's issue its Spec (same number; the Builder's words stay in its body) and files the Tickets as sub-issues in the Spec Stage with native blockers, and prints the cut. The file must say whether the Request touches architecture: an Architecture decision becomes the next numbered ADR, is named in the Stack section of AGENTS.md and committed. Running the command again replaces the whole cut, which also finishes a run GitHub cut short; the issue only carries the Spec Stage label while a whole cut stands.

Once the Builder confirms, `factory spec confirm <spec>` moves the Spec to the Design Stage. Its Tickets stay in the Spec Stage until the Design is approved; the Ticket loop builds only Tickets in the Build Stage.

## Design

Every design ends as the Design handoff, the committed folder `design/`: `DESIGN.md` (the source of the design), `tokens.json` (DTCG tokens generated from it), `screenshots/` (a reference screenshot per route), `sample/` or `reference/` (the sample page, or a design tool's code: reference only, never copied into the Site), `assets/` (a tool's images, fonts and video, which the Site may use) and `source.json` (the provenance record: tool, how it was made, where it was fetched from, Spec, format version, date, routes).

Without a design tool, the `design` skill writes `design/DESIGN.md` and a sample page from the Spec, and `factory design <spec>` makes the rest and commits it. It refuses a DESIGN.md that fails its lint or its contrast check, or that does not name the pinned format version, and changes nothing then. The contrast check counts a warning from the linter as a failure and needs at least one component with both a background and a text color, since it could otherwise measure nothing. The linter cannot measure a see-through color, so a component's text or background color must be solid.

With a design tool, one of three import skills does the fetching: `import-stitch`, `import-figma` or `import-claude-design`. The skill saves what the tool gave in `.factory/design-import/<tool>`, which git ignores, and writes `design/DESIGN.md`: Stitch exports one, and for the other two the model writes it from the tool's variables or pages. `factory design import <tool> <spec> [<where-it-came-from>]` then fills the same folder as the no-tool way and commits it. Stitch and Figma give a picture per screen; a picture that is missing or no PNG is refused and changes nothing. Claude Design gives pages, so the Factory opens them in a browser and takes the pictures itself. Importing again replaces every earlier import, and going back to no tool drops the tool's code. Claude Design hands over by itself only to Claude Code; under another Agent CLI the command explains the one manual step, downloading a `.zip` into that folder. The next run unpacks the `.zip` there, removes it, lists the images, fonts and video, and stops, so that what the Builder may not use is deleted before the run after it imports the rest. The readers in `src/design-import.ts` were built on hand-written examples of the tools' answers, since a session may not use a real account, so a first real import may need them corrected.

The skill shows the Builder the result and explains what approving means. `factory design approve <spec>` is the only way a Spec's Tickets reach the Build Stage; it refuses a handoff that does not stand, was made for another Spec, or has uncommitted changes. Asking for changes means changing the files and running `factory design <spec>` again, and the Spec stays in the Design Stage. The handoff lives on the base branch, because every Ticket starts from there.

The Review check `code/design` runs on every Ticket: DESIGN.md's lint and contrast, `tokens.json` still matching what DESIGN.md generates, a screenshot for every route in `source.json`, and no file of the Site being a whole copy of tool code in `design/reference` (a reworked copy goes unseen). It is reported as not run on a Site that never had a handoff. The DESIGN.md format version is pinned in `src/design-handoff.ts`, and the `@google/design.md` package at one exact version in `package.json`; `factory update` moves them on purpose.

## Approve

Once every Ticket of a Spec has Passed, the Ticket loop opens the Spec's pull request and moves the Spec to the Approve Stage. The `approve` skill walks the Builder through it: `factory approve <spec>` shows the Preview and the pull request, the Builder reads the Preview and, when the Site does what the Spec says, presses the merge button on GitHub themselves. No session merges: that button is the Builder's Approve. The same command run again sees the merge, also one made without the skill, and moves the Spec to the Publish Stage.

If the Builder asks for changes instead, the skill writes the change to a file and `factory approve change <spec> <change-file>` files it as a new Ticket in the Build Stage and moves the Spec back there. For several changes it runs once per change, while the pull request is open. The next `factory loop <spec>` builds it, pushes to the same pull request, makes a new Preview, and the Spec is back in Approve.

## What to do now

The `next` skill runs `factory next`, which reads the board and names exactly one action and the skill for it, or says that the action needs none. It picks what is closest to the Visitor first: a Spec to Approve, a Ticket that needs the Builder, a Ticket loop to start, then Design, Spec and Request. Only when nothing needs the Builder does it say to wait for a running Ticket loop, or to bring the next idea. Before Kickoff it says so without asking for a GitHub login.

## The board

`npm run board` (or `factory board`) opens a local page drawn like the workshop diagram: one column per Stage, Decision stages blue, Automatic stages green. Every open Request and Ticket sits in the column of its Stage label, with its attempt count, the failing Review check, the reason in plain words and the one next action. A Ticket parked on another machine shows too: its park comment carries the reason and the attempt count. A Ticket waiting on a rate limit shows as waiting, with its resume time. Below the columns stands the latest Run report of each Spec. The page reloads itself every 30 seconds, except while you read a whole reason, and the board stays open until you press Ctrl+C.

In a Codespace the command prints the address of the forwarded port; open that one. The board listens on port 4400 on your own machine only; `--port` picks another port, and `--json` prints the board's data once instead.

## Updating

`factory update` brings the newest Factory into the Site as a pull request the Builder approves by merging it: new or changed skills, Review checks, Modern Web Guidance and the DESIGN.md format version. It is the one thing that does not travel the Pipeline, because it carries the Factory, not a change to the Site.

The Site pins its Factory exactly in `package.json`; the Review checks and the DESIGN.md format version live in the Factory, so that one pin holds them too, and Modern Web Guidance is pinned by its vendored files. The command works from what is on GitHub, in a throwaway worktree, and pushes only the branch `factory-update`, so the base branch stays as it is until the merge, and the Builder's folder until they pull it. The pull request lists what changed, and ends with the two steps that bring a merged update to the Builder's computer: `git pull`, then `npm install`. Between the release the Site is on and the newest one, only the files that release changed come over; a file the Site changed itself and the release changed too (such as `AGENTS.md`, or a skill) stays as the Site has it and is listed. Running it again finds the open pull request; a newer release moves that same pull request on, and replaces any commit made by hand on that branch. If the DESIGN.md format moved, the pull request says that `design/DESIGN.md` must be rewritten, since its Review check fails until then. The Ticket loop's gate refuses a Ticket that moves a pin, so pins move only through this pull request. It also refuses a Ticket that deletes a test file, adds a skip, todo or focus marker (`.skip`, `.only`, `xit`, `{ skip: true }`, a pytest skip) to a test, or changes the Site's test script in `package.json` or its `testCommand`, since a green run then proves less than before.

The facts each release pins are in `packages/create-web-factory/release.json`, published with the starter; a test keeps them equal to the code. The update reads the Site's first files from the starter package at the pinned version and at the newest one, on npm.

## Report a bug

Something did not work? [Open a bug report](https://github.com/fabkrum/web-factory/issues/new?template=bug_report.yml). Plain words are fine.

## Development

The Factory package is `@fabkrum/web-factory`, with the command `factory`. It is written in TypeScript for Node 22.19 or later.

- `npm test` runs the tests. The Ticket loop is tested through the `factory` command in a throwaway Site repository, with a scripted fake Agent CLI and an in-memory fake tracker (`test/harness/`).
- `npm run typecheck` checks the types.
- `npm run build` compiles `src/` to `dist/`, which `bin/factory.js` runs.
- `node scripts/check-personal.mjs` fails when a tracked file holds anything personal. CI runs it, builds the Codespace's dev container and runs the installer twice on clean macOS and Linux runners (`.github/workflows/factory.yml`).
- Every night CI runs a fixed sample Spec through the Ticket loop on each supported Agent CLI and reports Pass, the parked reason or why it was skipped (`.github/workflows/nightly.yml`, `test/fixtures/sample-spec/`). It spends real money, so it never runs on a pull request; the workflow file names the secrets it needs.

The Codespace's dev container is in the starter's `template/` folder, so every Site carries it. The template repository is the output of `npm create web-factory@latest web-factory-template`, pushed to GitHub with **Template repository** ticked in its settings. It moves to a new Factory like any other Site, through `factory update`.

The starter package `create-web-factory` lives in `packages/create-web-factory`, with the Site's first files in its `template/` folder. It pins the Factory to its own version, so the two packages are always released together at one version. `npm pack` builds either package.

A Site records its Factory settings in `factory.json` at its root: `testCommand` (what green means for its stack), `serveCommand` (serves the built Site for Review, on the port it gets as `{port}` in the command or as `PORT`; the Ticket loop refuses a Site without it), and optionally `baseBranch` (default `main`), `sessionTimeoutMs` and `maxAttempts` (how many Build sessions a Ticket gets in one run before it parks, default 3), `serveTimeoutMs` (how long the Site gets to answer, default a minute), `buildCommand` (builds the Site for Review, left out when it has no build step), and `agentCli`: the Agent CLI that runs its sessions, `claude-code` (the default), `codex`, `antigravity` (Antigravity CLI, for a free Google account) or `gemini` (Gemini CLI, for a paid Gemini API key), and `localePack`: `de` switches on the German Locale pack. A Claude Code session stops with Claude Code's error when its sandbox cannot start, rather than run without it. Codex reads the Site's AGENTS.md and `.agents/skills` itself; its sandbox has no network, since Codex cannot limit it to the package registry. Antigravity CLI and Gemini CLI read the same two places; the Factory tells Gemini CLI to read AGENTS.md, which it would otherwise skip for GEMINI.md, and gives Antigravity CLI a print timeout past the session's own time limit, so its default does not cut a long session short.

The German Locale pack adds five Review checks in the Privacy & legal area, measured on the served Site as a first-time Visitor who has agreed to nothing: an Impressum and a privacy policy linked from every route (the pages must answer), prices in euros shown as gross prices (a note on the page saying they include VAT, or the small business rule of § 19 UStG), and no web font or other request to a third party before consent. The price check recognises common wording and does not prove a price is gross: one note counts for every price on the page, so a net price beside such a note, or in wording the check does not know, still passes. A subdomain of the Site's own host name counts as the Site's; a Google Fonts Site fails both third-party checks, because the stylesheet is a request and the font a font. With the pack off, none of them runs and the review says once that it checked no country's law and is not legal advice. Every reason the pack gives says the same.

The Ticket loop keeps its local state per Spec in `.factory/spec-<number>.json` (kept out of git): each Ticket's status (`building`, `reviewing`, `waiting`, `passed`, `parked`, `not-passed`, `blocked`), its attempt count and, when it is stuck, the reason in plain words, the failing Review checks and, while it waits on a rate limit, its resume time. The board reads it, and takes every Stage from the issues. A parked Ticket waits for the Builder: the loop leaves it alone until something happens on the Ticket after its park comment, such as the Builder's answer, and then builds it again with that answer in the prompt. Only comments by someone who may write to the repository count (on GitHub: its owner, a member or a collaborator): anyone may comment on a public repository, so the loop ignores every other comment, says in its output how many it ignored, and never puts one in a prompt.

After every run the Ticket loop writes a Run report: which Tickets went straight through, which needed fix rounds and why, what is parked and why, flaky tests, the time spent waiting on rate limits, and which Review checks failed. It arrives in plain words as a comment on the Spec and on the board, also when the run stopped early. A red test run gets one rerun: green on the rerun counts as a Pass and shows in the Run report as flaky. The Site's test, build and serve commands run without the Factory's secrets (every variable whose name says it is a token, key, password or credential), since what they print can reach a park comment, and the GitHub tracker masks any secret or token-shaped string in what it writes. Each report is stored for Measure in `.factory/run-reports/spec-<number>-run-<run>.json`; like the rest of `.factory`, these stay on the machine that ran the loop.

The loop builds the lowest-numbered Ticket whose blockers are all closed, and looks again after every Ticket. A Ticket whose blocker parked, did not pass or is still open stays unstarted, with that reason in its local state as `blocked`. When every Ticket of the Spec is closed, the loop pushes the Spec's integration branch `spec/<number>` to `origin` (that branch only, never the base branch), asks the host for a Preview URL, and opens one pull request against the base branch with the Preview URL in its body. A later run finds that pull request open instead of opening a second one.
