# web-factory

An agentic website factory: from request to measured live site, with the ticket loop doing the build and review on Gemini, Claude or OpenAI.

## License

MIT, see [LICENSE](LICENSE).

## Development

The Factory package is `@fabkrum/web-factory`, with the command `factory`. It is written in TypeScript for Node 22.19 or later.

- `npm test` runs the tests. The Ticket loop is tested through the `factory` command in a throwaway Site repository, with a scripted fake Agent CLI and an in-memory fake tracker (`test/harness/`).
- `npm run typecheck` checks the types.
- `npm run build` compiles `src/` to `dist/`, which `bin/factory.js` runs.

A Site records its Factory settings in `factory.json` at its root: `testCommand` (what green means for its stack), and optionally `baseBranch` (default `main`), `sessionTimeoutMs` and `maxAttempts` (how many Build sessions a Ticket gets in one run before it parks, default 3), and `agentCli`: the Agent CLI that runs its sessions, `claude-code` (the default), `codex`, `antigravity` (Antigravity CLI, for a free Google account) or `gemini` (Gemini CLI, for a paid Gemini API key), and `localePack`: `de` switches on the German Locale pack. Codex reads the Site's AGENTS.md and `.agents/skills` itself; its sandbox has no network, since Codex cannot limit it to the package registry. Antigravity CLI and Gemini CLI read the same two places; the Factory tells Gemini CLI to read AGENTS.md, which it would otherwise skip for GEMINI.md, and gives Antigravity CLI a print timeout past the session's own time limit, so its default does not cut a long session short.

The German Locale pack adds five Review checks in the Privacy & legal area, measured on the served Site as a first-time Visitor who has agreed to nothing: an Impressum and a privacy policy linked from every route (the pages must answer), prices in euros shown as gross prices (a note on the page saying they include VAT, or the small business rule of § 19 UStG), and no web font or other request to a third party before consent. A subdomain of the Site's own host name counts as the Site's; a Google Fonts Site fails both third-party checks, because the stylesheet is a request and the font a font. With the pack off, none of them runs and the review says once that it checked no country's law and is not legal advice. Every reason the pack gives says the same.

The Ticket loop keeps its local state per Spec in `.factory/spec-<number>.json` (kept out of git): each Ticket's status (`building`, `waiting`, `passed`, `parked`, `not-passed`, `blocked`), its attempt count and, when it is stuck, the reason in plain words. The board reads it. A parked Ticket waits for the Builder: the loop leaves it alone until something happens on the Ticket after its park comment, such as the Builder's answer, and then builds it again with that answer in the prompt.

The loop builds the lowest-numbered Ticket whose blockers are all closed, and looks again after every Ticket. A Ticket whose blocker parked, did not pass or is still open stays unstarted, with that reason in its local state as `blocked`. When every Ticket of the Spec is closed, the loop pushes the Spec's integration branch `spec/<number>` to `origin` (that branch only, never the base branch), asks the host for a Preview URL, and opens one pull request against the base branch with the Preview URL in its body. A later run finds that pull request open instead of opening a second one.
