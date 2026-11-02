---
name: design
description: Make a Spec's Design handoff and get the Builder's approval. With Stitch, Figma or Claude Design, hand over to that tool's import skill; without a design tool, write DESIGN.md and one sample page from the Spec. Use when a Spec waits in the Design Stage, or when the Builder wants to change a Design they have not approved yet.
---

# Design

The Design Stage turns a Spec into one folder, `design/`, that says how the Site looks. The Builder decides; you propose, explain and change.

Start by saying why this step exists: the Ticket loop builds unattended and decides nothing about looks by itself, so a design settled now keeps every page consistent, and a change now is cheap while a change after the build is not. Say it in two or three sentences, before you ask anything.

Follow the Modern Web Guidance skill. Follow the terminal rules in AGENTS.md.

If you do not know which Spec this is, list them with `gh issue list --label stage:design` and ask which one. Read it with `gh issue view <number>`.

## 1. Ask about the design tool

Ask whether the Builder designed this in Stitch, Figma or Claude Design, or wants no design tool. Every way ends in the same `design/` folder, so the Ticket loop builds the same way whichever they pick.

- Stitch: follow the `import-stitch` skill in `.agents/skills/import-stitch`, then go on at step 6.
- Figma: follow the `import-figma` skill, then go on at step 6.
- Claude Design: follow the `import-claude-design` skill, then go on at step 6.
- No tool: go on with step 2. You write the design and they judge it.

An import needs the Builder's own account with that tool. If they have none and want none, the no-tool way is just as good.

## 2. Ask what the Site should feel like

Ask one question at a time and say why it matters: who should feel what when they open the Site, and any colors, fonts or sites they already like. Give your recommended answer with each question. Stop when you could describe the look in two sentences.

## 3. Write DESIGN.md

Write `design/DESIGN.md`, in English, with the format's YAML front matter and these sections: Overview, Colors, Typography, Layout, Shapes, Components, Do's and Don'ts. To see the format's rules, run `npx design.md spec`.

The front matter must start with `version: alpha`, the format version this Site is pinned to. Do not change that line.

Define `colors`, `typography`, `rounded` and `spacing`, and under `components` at least the Site's main text on its background and its main button, each with `backgroundColor` and `textColor`, such as `"{colors.primary}"`. The contrast check reads those pairs.

## 4. Build one sample page

Build `design/sample/index.html` from the Spec: the page that shows the most of the design, with real content from the Spec, using exactly the colors, type and spacing of DESIGN.md. Keep its CSS and images in `design/sample`, with no requests to other servers. Link further pages from it only if the Builder asks to see them.

The sample shows the design and is not part of the Site. The Ticket loop never copies it.

## 5. Make the handoff

Run:

```sh
npx factory design <number>
```

It checks DESIGN.md, generates `design/tokens.json`, takes a reference screenshot of each page, writes the record `design/source.json`, and commits the folder. Run `git push` afterwards.

If it refuses, it says why: fix DESIGN.md and run it again, and when a color must change, tell the Builder why. Never edit `tokens.json` by hand. If it asks for a GitHub login, pass on the reason, the Builder runs `gh auth login` in their own terminal because it opens a browser, and you run the same command again.

## 6. Show it and ask

Show the Builder the screenshots in `design/screenshots`, and without a tool tell them where to open `design/sample/index.html`. Then say in plain words, in their language, what they are approving and why it binds every Ticket: this design is what the Site will look like, the Ticket loop builds every Ticket of this Spec from this folder alone without asking again, and approving is what sends the Tickets to the Ticket loop.

Ask them to approve it or to ask for changes.

If they want a change, change the files, run `npx factory design <number>` again, show the new result and ask again. An imported design changes in its tool: they change it there, and you follow its import skill again. The Spec stays in the Design Stage. Never treat silence or a change request as approval.

## 7. Approve

Only after the Builder approves, run:

```sh
npx factory design approve <number>
```

The Spec's Tickets move to the Build Stage, and only now can the Ticket loop pick them up. Tell the Builder that, and that the next step is to start it with `npx factory loop <number>`.
