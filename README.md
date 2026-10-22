# web-factory

An agentic website factory: from request to measured live site, with the ticket loop doing the build and review on Gemini, Claude or OpenAI.

## License

MIT, see [LICENSE](LICENSE).

## Development

The Factory package is `@fabkrum/web-factory`, with the command `factory`. It is written in TypeScript for Node 22.18 or later.

- `npm test` runs the tests. The Ticket loop is tested through the `factory` command in a throwaway Site repository, with a scripted fake Agent CLI and an in-memory fake tracker (`test/harness/`).
- `npm run typecheck` checks the types.
- `npm run build` compiles `src/` to `dist/`, which `bin/factory.js` runs.

A Site records its Factory settings in `factory.json` at its root: `testCommand` (what green means for its stack), and optionally `baseBranch` (default `main`), `sessionTimeoutMs` and `maxAttempts` (how many Build sessions a Ticket gets in one run before it parks, default 3).

The Ticket loop keeps its local state per Spec in `.factory/spec-<number>.json` (kept out of git): each Ticket's status (`building`, `waiting`, `passed`, `parked`, `not-passed`, `blocked`), its attempt count and, when it is stuck, the reason in plain words. The board reads it. A parked Ticket waits for the Builder: the loop leaves it alone until something happens on the Ticket after its park comment, such as the Builder's answer, and then builds it again with that answer in the prompt.

The loop builds the lowest-numbered Ticket whose blockers are all closed, and looks again after every Ticket. A Ticket whose blocker parked, did not pass or is still open stays unstarted, with that reason in its local state as `blocked`. When every Ticket of the Spec is closed, the loop pushes the Spec's integration branch `spec/<number>` to `origin` (that branch only, never the base branch), asks the host for a Preview URL, and opens one pull request against the base branch with the Preview URL in its body. A later run finds that pull request open instead of opening a second one.
