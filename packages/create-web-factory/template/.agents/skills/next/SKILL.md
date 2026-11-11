---
name: next
description: Read the board and tell the Builder in plain words the one thing to do now and which skill to use. Use when the Builder asks what to do, what comes next or where their work stands, or at the start of any session.
---

# Next

This is the Builder's single entry point, so they never have to remember the Pipeline.

Start by saying why this step exists, in one sentence: the Factory knows where the work stands, so the Builder only ever has to do one thing at a time.

Follow the terminal rules in AGENTS.md.

## 1. Read the board

Run:

```sh
npx factory next
```

It prints one action, then the skill to use for it or that no skill is needed. Add nothing to it from your own judgment: the command has already chosen among everything on the board.

If it asks for a GitHub login, pass on the reason, the Builder runs `gh auth login` in their own terminal because it opens a browser, and you run the same command again. If it refuses, say why in plain words.

## 2. Say it in plain words

Tell the Builder, in their language, the one action and why it comes now. Explain any word they may not know. Name one action, never a list.

## 3. Go on

If a skill is named, ask whether they want to start it now, and if so follow that skill in `.agents/skills`. If the action is a terminal command, give it by the terminal rules. If it says nothing is to do, say what the Factory is doing by itself and that they can come back at any time.

The Builder wants the whole picture? `npm run board` opens the board.
