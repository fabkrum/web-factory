# web-factory

An agentic website factory: from request to measured live site, with the ticket loop doing the build and review on Gemini, Claude or OpenAI.

## License

MIT, see [LICENSE](LICENSE).

## Start a Site

```sh
npm create web-factory@latest my-site
```

This creates a Site repository in `my-site`: the Factory pinned as a dependency with its `factory` command, one AGENTS.md, the shared skills folder `.agents/skills`, and Modern Web Guidance vendored there at a pinned version with its licence and notice. Claude Code reaches the same instructions and skills through a CLAUDE.md that imports AGENTS.md and the link `.claude/skills`; Gemini CLI through `.gemini/settings.json`. Running the command again adds only what is missing, so it finishes a run that was cut short and changes nothing in a finished Site.

## Kickoff

Before the first Request, the `kickoff` skill in the Site's `.agents/skills` guides the Builder: who the Site is for, what it must do, how often its content changes, where its operator and Visitors are, and which Agent CLI they use (there is no default). It recommends a stack and a host with the case for and against each option, the Builder decides, and it sets up the chosen stack. It then writes the decisions to a file and runs `factory kickoff <decisions-file>`, which records them and commits: `docs/adr/0001-stack.md` and `docs/adr/0002-host.md` with every option offered, the Stack section in AGENTS.md, and `agentCli`, `host`, `testCommand`, `buildCommand`, `serveCommand` and `localePack` in `factory.json`. An operator or Visitors in Germany switch the German Locale pack on. Last it creates the Stage labels on GitHub. If GitHub cannot be reached the record stays, and running the same command again finishes it; once recorded, different decisions are refused, because a change to the architecture is a new Architecture decision in a Spec. Firebase is the only host the Factory connects itself; for any other host the decisions must carry that host's own setup (`host.setup`), which is recorded and shown as the Builder's next step, so it may hold no line starting with `## `.

## Request and Spec

A Builder describes an idea or a bug in their own words; the `request` skill writes it to a file and runs `factory request <request-file>`, which files it as an issue in the Request Stage. Before any GitHub login, the command says why a login is needed now and changes nothing; running it again afterwards files the Request.

The `spec` skill questions the Builder until the Request is precise, agrees how to tell that the Site does what it should, and cuts the work into thin vertical Tickets, splitting any it judges too big for one session. `factory spec <spec-file>` then makes the Request's issue its Spec (same number; the Builder's words stay in its body) and files the Tickets as sub-issues in the Spec Stage with native blockers, and prints the cut. The file must say whether the Request touches architecture: an Architecture decision becomes the next numbered ADR, is named in the Stack section of AGENTS.md and committed. Running the command again replaces the whole cut, which also finishes a run GitHub cut short; the issue only carries the Spec Stage label while a whole cut stands.

Once the Builder confirms, `factory spec confirm <spec>` moves the Spec to the Design Stage. Its Tickets stay in the Spec Stage until the Design is approved; the Ticket loop builds only Tickets in the Build Stage.

## Design

Every design ends as the Design handoff, the committed folder `design/`: `DESIGN.md` (the source of the design), `tokens.json` (DTCG tokens generated from it), `screenshots/` (a reference screenshot per route), `sample/` (reference only, never copied into the Site) and `source.json` (the provenance record: tool, how it was made, Spec, format version, date, routes).

Without a design tool, the `design` skill writes `design/DESIGN.md` and a sample page from the Spec, and `factory design <spec>` makes the rest and commits it. It refuses a DESIGN.md that fails its lint or its contrast check, or that does not name the pinned format version, and changes nothing then. The contrast check counts a warning from the linter as a failure and needs at least one component with both a background and a text color, since it could otherwise measure nothing. The linter cannot measure a see-through color, so a component's text or background color must be solid. Import skills for Stitch, Figma and Claude Design are not here yet.

The skill shows the Builder the result and explains what approving means. `factory design approve <spec>` is the only way a Spec's Tickets reach the Build Stage; it refuses a handoff that does not stand, was made for another Spec, or has uncommitted changes. Asking for changes means changing the files and running `factory design <spec>` again, and the Spec stays in the Design Stage. The handoff lives on the base branch, because every Ticket starts from there.

The Review check `code/design` runs on every Ticket: DESIGN.md's lint and contrast, `tokens.json` still matching what DESIGN.md generates, and a screenshot for every route in `source.json`. It is reported as not run on a Site that never had a handoff. The DESIGN.md format version is pinned in `src/design-handoff.ts`, and the `@google/design.md` package at one exact version in `package.json`; `factory update` will move them on purpose.

## Development

The Factory package is `@fabkrum/web-factory`, with the command `factory`. It is written in TypeScript for Node 22.19 or later.

- `npm test` runs the tests. The Ticket loop is tested through the `factory` command in a throwaway Site repository, with a scripted fake Agent CLI and an in-memory fake tracker (`test/harness/`).
- `npm run typecheck` checks the types.
- `npm run build` compiles `src/` to `dist/`, which `bin/factory.js` runs.

The starter package `create-web-factory` lives in `packages/create-web-factory`, with the Site's first files in its `template/` folder. It pins the Factory to its own version, so the two packages are always released together at one version. `npm pack` builds either package.

A Site records its Factory settings in `factory.json` at its root: `testCommand` (what green means for its stack), `serveCommand` (serves the built Site for Review, on the port it gets as `{port}` in the command or as `PORT`; the Ticket loop refuses a Site without it), and optionally `baseBranch` (default `main`), `sessionTimeoutMs` and `maxAttempts` (how many Build sessions a Ticket gets in one run before it parks, default 3), `serveTimeoutMs` (how long the Site gets to answer, default a minute), `buildCommand` (builds the Site for Review, left out when it has no build step), and `agentCli`: the Agent CLI that runs its sessions, `claude-code` (the default), `codex`, `antigravity` (Antigravity CLI, for a free Google account) or `gemini` (Gemini CLI, for a paid Gemini API key). Codex reads the Site's AGENTS.md and `.agents/skills` itself; its sandbox has no network, since Codex cannot limit it to the package registry. Antigravity CLI and Gemini CLI read the same two places; the Factory tells Gemini CLI to read AGENTS.md, which it would otherwise skip for GEMINI.md, and gives Antigravity CLI a print timeout past the session's own time limit, so its default does not cut a long session short.

The Ticket loop keeps its local state per Spec in `.factory/spec-<number>.json` (kept out of git): each Ticket's status (`building`, `waiting`, `passed`, `parked`, `not-passed`, `blocked`), its attempt count and, when it is stuck, the reason in plain words. The board reads it. A parked Ticket waits for the Builder: the loop leaves it alone until something happens on the Ticket after its park comment, such as the Builder's answer, and then builds it again with that answer in the prompt.

The loop builds the lowest-numbered Ticket whose blockers are all closed, and looks again after every Ticket. A Ticket whose blocker parked, did not pass or is still open stays unstarted, with that reason in its local state as `blocked`. When every Ticket of the Spec is closed, the loop pushes the Spec's integration branch `spec/<number>` to `origin` (that branch only, never the base branch), asks the host for a Preview URL, and opens one pull request against the base branch with the Preview URL in its body. A later run finds that pull request open instead of opening a second one.
