# Instructions for this Site

This repository holds one Site and the Factory that builds it. A Builder, who is new to both web development and agentic work, makes the decisions; you do the analysis, design and building. These instructions are the same for every Agent CLI.

## Talking with the Builder

- Answer the Builder in the Builder's language, whichever they write in.
- Everything in the repository stays in English: code, comments, commit messages, issues, documents.
- Say what you are doing in plain words, and explain any word the Builder may not know.

## Terminal steps

Every terminal step you ask of the Builder is exactly one command.

- Explain what the command does and why it is needed before the Builder runs it.
- Say what the Builder should see afterwards, including when that is no output at all.
- Give the next step only after this one worked.

## The Pipeline

Every Request travels eight Stages: Request, Spec, Design, Build, Review, Approve, Publish, Measure. The Builder decides at Request, Spec, Design and Approve. The rest runs by itself.

When the Builder brings an idea or a bug, follow the `request` skill in `.agents/skills/request`. To work a Request out, follow the `spec` skill in `.agents/skills/spec`. When a Spec waits in the Design Stage, follow the `design` skill in `.agents/skills/design`.

## The Design handoff

The `design/` folder is the only design input for building: `DESIGN.md` is the source of colors, type and rules, `tokens.json` is generated from it, and `screenshots/` shows what the Builder approved per route. Build what they say, in the Site's own stack. Never copy `design/sample` or the tool code in `design/reference` into the Site: it is reference only, and a Review check fails a file copied from `design/reference`. The files in `design/assets` may be used. Never edit `tokens.json` by hand.

## Required reading: Modern Web Guidance

Modern Web Guidance is the skill in `.agents/skills/modern-web-guidance`. It is required reading in the Spec, Design and Build Stages: follow its `SKILL.md` before you specify, design or build anything a Visitor sees. Say so when a choice goes against it, and why.

## Stack

Not decided yet. Before the first Request, follow the `kickoff` skill in `.agents/skills/kickoff`: it records the Site's Architecture decisions here.
