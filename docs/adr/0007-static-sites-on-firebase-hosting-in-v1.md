# Sites are static in v1, and Firebase App Hosting is not offered

Amends ADR 0003, which leaves the stack to the Builder: in v1 that choice is limited to stacks with static output. Firebase Hosting is the recommended default host, and Firebase App Hosting is no longer the recommendation for a Site that needs a server.

Fabian decided this on 2026-11-02, on Ticket #20. The reason: the Ticket loop needs a Preview per Ticket, and App Hosting has none. Firebase's App Hosting overview, read on 2026-11-02, describes one live branch and mentions no preview channels or per-branch previews. Sites that run server code may come back in a later version.

We rejected a second App Hosting backend per Spec as a Preview, because it needs a new design and testing on a real account. We rejected keeping App Hosting without a Ticket loop, because it breaks the promise that every host gives the Builder a Preview URL.

## Consequences

The kickoff skill and the README say so. Added while building this, and not part of the decision: `factory kickoff` refuses App Hosting even when the decisions carry a setup for it, so a Site cannot be recorded on a host the Ticket loop cannot serve. Other hosts keep their route through `host.setup`.

The Spec's line "Firebase App Hosting when a server is needed" is in GitHub issue #1, which a Ticket session may not edit. It is superseded by this record until that line is changed by hand.
