---
name: approve
description: Walk the Builder through reading a Spec's Preview and merging its pull request, or turn what they want changed into a new Ticket. Use when a Spec waits in the Approve Stage.
---

# Approve

Approve is the last decision before the Site changes for its Visitors. The Builder decides; you guide and explain.

Start by saying why this step exists: the Review checks measured what tools can measure, but only the Builder can say whether this is what they asked for. Merging the pull request is how real teams say yes, and it is what publishes the Site. Say it in two or three sentences, before you ask anything.

Follow the terminal rules in AGENTS.md.

If you do not know which Spec this is, list them with `gh issue list --label stage:approve` and ask which one.

## 1. Show where to read

Read the Spec with `gh issue view <number>`, then run:

```sh
npx factory approve <number>
```

It prints the Preview's address and the pull request's. If it says the Spec is already approved, tell the Builder and stop. If it asks for a GitHub login, pass on the reason, the Builder runs `gh auth login` in their own terminal because it opens a browser, and you run the same command again. If it refuses, say why in plain words and do what it says.

## 2. Read the Preview together

Explain what the Preview is: a private copy of the Site that no Visitor sees. Give them its address and the points under "How to tell that it does" in the Spec, one at a time, and ask them to check each on the Preview. Ask them to try it on a phone too.

Then ask: does the Site do what the Spec says, or do you want something changed? Never treat silence as approval.

## 3. If they want a change

Ask what should be different until you could say what a person would check. Write `.factory/change.json`, in English:

```json
{
  "title": "...",
  "delivers": "What a person can see or check once this is done.",
  "acceptance": ["..."]
}
```

Then run:

```sh
npx factory approve change <number> .factory/change.json
```

It files a new Ticket in the Build Stage and moves the Spec back there. For several changes, run it once per change, with one file each. Something that goes beyond this Spec belongs in a new Request: say so and use the `request` skill.

Tell the Builder the pull request stays open, and that the next step is to start the Ticket loop with `npx factory loop <number>`. Once it is done, the Spec is back here with a new Preview. Stop here.

## 4. If they approve

The merge is theirs: you never merge a pull request. Explain what merging does: the Spec's work joins the main branch, and that publishes the Site to its Visitors.

Give them the pull request's address. Tell them to open it in their browser, press "Merge pull request", then "Confirm merge", and to tell you when it is done. They should see "Pull request successfully merged and closed".

If GitHub says the branch has conflicts, tell them not to resolve it on GitHub: it means the main branch changed since the Ticket loop began. Go to step 3 with a change that brings the main branch into this work, and with this as its title: "Bring the main branch into this Spec".

## 5. Finish

Once they say it is merged, run:

```sh
npx factory approve <number>
```

It checks the merge and moves the Spec to the Publish Stage. If it says the pull request is not merged yet, tell the Builder and go back to step 4.

Then bring this repository up to date, because the next Spec starts from the main branch and GitHub now has the newer one:

```sh
git pull
```

Tell the Builder the Spec is approved and that Publish and Measure run by themselves. The `next` skill tells them what comes after.
