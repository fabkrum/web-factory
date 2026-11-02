---
name: spec
description: Question the Builder about a Request until it is precise, write the Spec with how to tell that it works, cut it into Tickets and get the cut confirmed. Use when a Request waits in the Request Stage, when a Spec's cut has not been confirmed yet, or when the Builder wants to change an unconfirmed cut.
---

# Spec

The Spec turns a Request into what the Site should do and how to tell that it does. The Builder decides; you ask, explain and recommend.

Start by saying why this step exists: an unattended Ticket loop builds exactly what is written, so a question answered now is cheap and a misunderstanding found after the build is not. Say it in two or three sentences, before you ask anything.

Follow the Modern Web Guidance skill for anything a Visitor sees. Follow the terminal rules in AGENTS.md.

If you do not know which Request this is, list the open ones with `gh issue list --label stage:request` and ask which one. Read it with `gh issue view <number>`. If an earlier cut of it waits in the Spec Stage, show the Builder that cut first.

## 1. Question the Builder until the Request is precise

Ask one question at a time and wait for the answer. Say why each question matters. Explain any word the Builder may not know. Give your recommended answer with each question. If the code can answer a question, read the code instead of asking.

Stop when you could say what each page or behaviour does, what is left out, and what happens when something goes wrong.

## 2. Agree how to tell

Write down with the Builder how to tell that the Site does what it should. Each point is something a person can check on the Site, such as "the page /menu lists every dish with its price". "Pass" means these points, so read them back and ask whether they are what the Builder wants.

## 3. Spot an Architecture decision

Check the Request against the Stack section of AGENTS.md and `docs/adr/`. It touches architecture when it changes the stack, the rendering, the host, or adds something the Site depends on for good, such as a database, a login, a content system or a payment provider.

If it does, stop and say so in plain words: the Site's architecture changes deliberately, never by drift. Guide the Builder as Kickoff did. Offer at least two options, give the case for and against each, say which you recommend and why, and let them choose. A Builder who picks against your recommendation has made a valid choice.

If the decision changes a command in `factory.json`, a Ticket of this Spec makes that change.

## 4. Cut the Spec into Tickets

Cut it into thin vertical slices. Each Ticket delivers something a person can see or check, through every layer it needs, and can be built by itself once its blockers are done. Do not cut by layer, such as "all the styles" and then "all the content".

Before the Builder sees anything, judge each Ticket: could one session finish it? A Ticket that has several separate results, touches many pages at once, or holds an "and" that could be two Tickets is too big. Split it. The Builder sees only the cut after splitting.

Give each Ticket the Tickets that must be finished first. Name a blocker only when the Ticket truly cannot start without it.

## 5. Record the Spec

Write `.factory/spec.json`, in English. `request` is the Request's number. `blockedBy` holds positions in this list, counted from 1. `architectureDecision` is `null` when the Request touches no architecture; otherwise it is the decision, with every option you offered.

```json
{
  "request": 12,
  "title": "...",
  "shouldDo": "What the Site or the Factory should do, what is left out, and what happens when something goes wrong.",
  "howToTell": ["...", "..."],
  "architectureDecision": {
    "title": "...",
    "chosen": "...",
    "recommended": "...",
    "reason": "Why the Builder chose it, in one or two sentences.",
    "options": [
      { "name": "...", "for": "...", "against": "..." },
      { "name": "...", "for": "...", "against": "..." }
    ]
  },
  "tickets": [
    { "title": "...", "delivers": "...", "acceptance": ["..."], "blockedBy": [] },
    { "title": "...", "delivers": "...", "acceptance": ["..."], "blockedBy": [1] }
  ]
}
```

Then run:

```sh
npx factory spec .factory/spec.json
```

It writes the Spec on the Request's issue, keeping the Builder's own words there, and files the Tickets in the Spec Stage. If it records an Architecture decision, run `git push` afterwards. If it refuses, it says why: fix the file or ask the Builder what is missing, then run it again. If it asks for a GitHub login, pass on the reason, the Builder runs `gh auth login` in their own terminal because it opens a browser, and you run the same command again. The same goes for an error from GitHub: running the same command again finishes the step.

## 6. Show the cut and ask

The command prints the cut. Show it to the Builder in plain words, in their language:

- what each Ticket delivers
- what blocks it
- why the cut is vertical: each Ticket works by itself, so the Ticket loop can check it and a problem stays small and easy to find

Say that nothing is built until they confirm. Then ask them to confirm the cut or change it. Ask whether a Ticket looks too big or comes in the wrong order.

If they want a change, change `.factory/spec.json` and run `npx factory spec .factory/spec.json` again. It replaces the whole cut. Show the new cut and ask again. Never treat silence or a change request as confirmation.

## 7. Confirm

Only after the Builder confirms, run:

```sh
npx factory spec confirm <number>
```

The Spec moves on to the Design Stage. Its Tickets stay in the Spec Stage and reach the Build Stage, and with it the Ticket loop, only once the Builder approves the Design. Tell them that, and that their next step is the `design` skill.
