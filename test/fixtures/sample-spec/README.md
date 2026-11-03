# The sample Spec

Seam 3: every night CI runs this fixed Spec through the Ticket loop once per supported Agent CLI (`.github/workflows/nightly.yml`).

`site/` is a small Site that passes every Review check as it is. `test/harness/sample-spec.ts` makes a throwaway Site repository from it, with the instructions and skills of the starter's template and the Stack section in `stack.md`. `spec.json` holds the Spec and its one Ticket, which is small on purpose: every session of it costs real money.

Only the Agent CLI is real. The tracker and the host are the fakes from the test harness, because neither depends on the Agent CLI and the GitHub tracker has its own contract test. The Review checks are real.

`test/sample-spec.test.ts` builds the Ticket's solution with a scripted Agent CLI under the real Review checks, so a change that makes this Spec impossible to Pass fails in the test suite and not at night.

`tests/home.mjs` is not named `*.test.mjs`, so the Factory's own test run leaves it to the Site.
