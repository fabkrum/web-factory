# Improvements to the Factory travel the Pipeline as Requests

Measure measures the Factory as well as the Site: it reads the Run reports and, when a pattern shows (the same Review check failing across Tickets, Tickets too big to finish, repeated parks for the same reason), proposes a Request to change the Factory's setup in the Site, such as its instructions, DESIGN.md or the test command. Those Requests take the same path as any other: the Builder decides at Request, and the change goes through Spec, the Ticket loop, Review and Approve.

We rejected a separate retro pull request beside the Pipeline. It would be faster, but it would be a second way for the Site to change, and it would let the Ticket loop rewrite its own instructions without Review and Approve.

Sharing upward is a separate, deliberate act: Factory feedback goes to the Factory's maintainers only when the Builder sends it, after seeing exactly what it contains. Automatic telemetry stays out.
