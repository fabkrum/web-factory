# The stack is chosen per Site, not fixed by the Factory

The Factory does not ship a fixed stack. At the start of every Site the model guides the Builder through Architecture decisions with questions and recommends what suits the Site they want to build. The site machine fixed Astro + TypeScript, which gave the checks a known structure to rely on; we gave that up so the Factory fits more than brochure sites and so Builders learn why a stack is chosen.

## Consequences

Review checks must measure the built and served Site (a URL), not stack-specific source files. Anything stack-specific, such as the test command, is recorded by the Architecture decision and read by the Ticket loop.
