---
name: request
description: File an idea or a bug the Builder describes in their own words as a Request, an issue in the Request Stage. Use when the Builder wants something new or changed on their Site, reports something broken, or asks to add an idea.
---

# Request

A Request is the start of the Pipeline: one idea or one bug, in the Builder's own words.

Start by saying why this step exists: writing an idea down as a Request keeps it from getting lost, and it is how real teams track work, each piece of work as one issue on GitHub. Say it in two sentences, before you ask anything.

Follow the terminal rules in AGENTS.md: when the Builder has to run something, it is one command, explained first, with what they should see afterwards.

## 1. Hear the idea or bug

Ask the Builder what they want or what is wrong, in their own words. They need no special format and no issue syntax. If they bring two separate things, say so and file two Requests, one after the other.

Do not question them closely here: making it precise is the next step, in the `spec` skill. Ask only what you need to tell one Request from another. For a bug, that is what they did and what they saw.

## 2. File it

Write `.factory/request.json`, in English, keeping their meaning. Translate if they wrote in another language, and do not add ideas of your own:

```json
{
  "title": "A short name for the idea or bug",
  "body": "What the Builder said, in full."
}
```

Then run:

```sh
npx factory request .factory/request.json
```

## 3. If it asks for a GitHub login

Nothing is lost. Requests live on GitHub, so this is the moment a login is first needed. Pass on the reason the command gives, in plain words. The Builder runs `gh auth login` in their own terminal, because it opens a browser. Tell them what to answer as each question comes. Do not ask them to create anything else.

If the repository has no GitHub remote yet, create one with `gh repo create <name> --private --source=. --push`.

Then run the same `npx factory request` command again: that files the Request. For any other refusal, read what it says, fix it, and run the same command again.

## 4. The Builder's next step

Tell the Builder the Request's number and that it is filed. Their next step is the `spec` skill, which works it out with them. Offer to start it now.
