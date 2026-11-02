---
name: kickoff
description: Guide the Builder through a new Site's first Architecture decisions and record them. Use before the Site's first Request, while the Stack section of AGENTS.md says "Not decided yet", or when the Builder asks to start or set up their Site.
---

# Kickoff

Kickoff happens once, before the Site's first Request. The Builder decides; you ask, explain and recommend.

Start by saying why this step exists: a Site built on deliberate choices stays understandable, and every later session and every Agent CLI will build the same way because the choices are written down. Say it in two or three sentences, before you ask anything.

Ask one question at a time and wait for the answer. Say why each question matters. Explain any word the Builder may not know. Follow the terminal rules in AGENTS.md: when the Builder has to run something, it is one command, explained first, with what they should see afterwards.

## 1. Ask about the Site

1. Who is the Site for?
2. What must it do?
3. How often does its content change, and who changes it?
4. Where is the person or company that runs the Site, and where are its Visitors? Ask directly whether any Visitors are in Germany, also when the Builder says "everywhere": the answer switches on checks for German law. Note each country as its two-letter code (DE for Germany, AT for Austria), whatever language the Builder answers in.

## 2. Ask which Agent CLI the Builder uses

Ask which one they use: Claude Code (`claude-code`), Codex (`codex`), Antigravity CLI (`antigravity`) or Gemini CLI (`gemini`). There is no default. Do not assume the one you are running in, and do not recommend one: ask, and record their answer.

## 3. Recommend a stack and a host

Offer at least two stacks and at least two hosts that fit the answers. For each option, give the case for and the case against in plain words. Then say which you recommend and why, and let the Builder choose. A Builder who picks against your recommendation has made a valid choice.

- Follow the Modern Web Guidance skill when you weigh stacks.
- This version of the Factory supports static output: recommend only stacks that produce it. A Site that needs a server has to wait for a later version: tell the Builder so, plainly, before they choose.
- Firebase Hosting is the recommended default host. Recommend something else when the answers call for it.
- Do not offer Firebase App Hosting: it has no preview channels, and `factory kickoff` refuses it.
- Offer only hosts that give a Preview URL for a pull request. Approve needs something for the Builder to read.
- If the Builder chooses a host other than Firebase Hosting, tell them the Factory has no adapter for it yet. Find out that host's own setup, and keep it as the text for `host.setup`: what the Builder has to do next, in plain words, with no line starting with `## `.

## 4. Set up the stack

Add the chosen stack to the repository with the smallest working page and one test, then find its three commands by running them:

- **Test**: what green means. It must pass now, because the Ticket loop refuses to start on red tests.
- **Build**: leave it out when the stack has no build step.
- **Serve**: serves the built Site for Review. It must listen on the port it gets, written as `{port}` in the command or read from the `PORT` environment variable.

Commit this.

## 5. Connect GitHub

Stage labels live on GitHub, so this is the moment a login is first needed. Say that, and that the Site's issues will live there. If `gh auth status` says the Builder is not logged in, they run `gh auth login` in their own terminal. If the repository has no GitHub remote yet, create one with `gh repo create <name> --private --source=. --push`.

## 6. Record the decisions

Write the decisions to `.factory/kickoff.json`, in English, in this shape. Include every option you offered, also the ones not chosen. Leave out `commands.build` when there is no build step and `host.setup` for Firebase Hosting.

```json
{
  "site": { "audience": "...", "purpose": "...", "changeFrequency": "..." },
  "location": { "operatorCountry": "DE", "visitorCountries": ["DE", "AT"] },
  "agentCli": "...",
  "stack": {
    "chosen": "...",
    "recommended": "...",
    "reason": "Why the Builder chose it, in one or two sentences.",
    "options": [
      { "name": "...", "for": "...", "against": "..." },
      { "name": "...", "for": "...", "against": "..." }
    ]
  },
  "host": {
    "chosen": "...",
    "recommended": "...",
    "reason": "...",
    "options": [
      { "name": "...", "for": "...", "against": "..." },
      { "name": "...", "for": "...", "against": "..." }
    ],
    "setup": "..."
  },
  "commands": { "test": "...", "build": "...", "serve": "..." }
}
```

Then run:

```sh
npx factory kickoff .factory/kickoff.json
```

It writes the ADRs, the Stack section in AGENTS.md and `factory.json`, commits them and creates the Stage labels on GitHub. If it refuses, it says why: fix the file or ask the Builder what is missing, then run it again. If it reports that GitHub could not be reached, fix that and run the same command again. Afterwards run `git push` so that GitHub has the record.

Tell the Builder in plain words what was recorded, and pass on what the command says about the Locale pack, including that it is not legal advice.

## 7. The Builder's next step

The command prints it. For another host, it is that host's own setup: walk the Builder through it one step at a time.

For Firebase Hosting, connect hosting to GitHub, so that pull requests get a Preview and merging publishes without the Builder creating any secret by hand. Go one step at a time, waiting for each to work:

1. The Builder logs in with `npx firebase-tools login` in their own terminal, because it opens a browser. The Ticket loop deploys each Preview with this login.
2. They run `npx firebase-tools init hosting` in their own terminal, because it asks questions. Tell them what to answer as each question comes:
   - The public directory is the folder the Site's build command writes to, or the folder holding the pages when there is no build step.
   - Say yes to setting up automatic builds and deploys with GitHub. Firebase then stores a key on GitHub by itself.
   - Say yes to a build script when the Site has a build command, and answer with `npm ci` followed by that command.
   - Say **no** to automatic deployment when a pull request is merged: the Factory's own Publish does that in the next step.
3. Run `npx factory connect-host`. It writes the workflow that publishes on every merge into the base branch. If it refuses, it says why: fix that and run it again.
4. Commit what these steps wrote and run `git push`.

Then tell the Builder that Kickoff is finished and that their next step is their first Request.
