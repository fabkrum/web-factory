# The Design handoff is a DESIGN.md folder, whatever tool made it

Every design tool (Stitch, Figma, Claude Design, or none) is reduced by its own import skill to one committed folder: `DESIGN.md` as the single source of design tokens and rules, `tokens.json` generated from it in the DTCG 2025.10 format, a required reference screenshot per route, the tool's own code only as optional reference, licensed assets, and a `source.json` recording where and how it was fetched. The Ticket loop builds from that folder alone and never copies a tool's generated code, because the stack comes from the Architecture decision, not from the design tool.

We chose DESIGN.md (Google Labs, Apache-2.0) over a factory-specific format because Stitch already exports it and its CLI lints contrast and exports DTCG; it is alpha, so the Factory pins its version and `factory update` moves it on purpose. Claude Design can only be fetched automatically from Claude Code; other Agent CLIs get a guided manual download.
