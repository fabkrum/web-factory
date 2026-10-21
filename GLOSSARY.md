# web-factory

A website factory that takes a Builder's idea through a fixed Pipeline to a measured live Site, with an AI model doing the analysis, design and building, and the Builder making the decisions.

## People

**Builder**:
The person who uses the factory to make a Site, assumed to be a full beginner in both web development and agentic work.
_Avoid_: user, attendee, student, operator, owner

**Visitor**:
A real person using the published Site.
_Avoid_: user, customer

## The Site

**Site**:
The website a Builder makes; one Site lives in one repository, with its Factory inside it.
_Avoid_: project, app

**Factory**:
The instructions, skills, Review checks and dashboard that sit inside a Site's repository and run its Pipeline.
_Avoid_: machine, harness, framework

**Kickoff**:
The one-time conversation before a Site's first Request, in which the Builder makes the Site's first Architecture decisions.
_Avoid_: onboarding, setup, init

**Architecture decision**:
A choice about how the Site is built (stack, rendering, hosting), made by the Builder after the model has guided them with questions.
_Avoid_: tech choice, stack pick

**Agent CLI**:
The command-line coding tool the Factory drives to do a Stage's work: Antigravity CLI, Gemini CLI, Codex or Claude Code.
_Avoid_: model, assistant, harness, agent

## The Pipeline

**Pipeline**:
The fixed sequence of Stages every Request travels through: Request, Spec, Design, Build, Review, Approve, Publish, Measure.
_Avoid_: workflow, process, flow

**Stage**:
One step of the Pipeline; a Decision stage waits for the Builder, an Automatic stage runs by itself.
_Avoid_: step, phase, column

**Request**:
An idea or a bug for the Site or for its Factory, brought by the Builder or proposed by Measure.
_Avoid_: feature request, wish, idea

**Spec**:
A Request worked out into what the Site or its Factory should do and how to tell that it does.
_Avoid_: PRD, requirements, plan

**Ticket**:
One independently buildable slice of a Spec.
_Avoid_: task, story, issue

**Ticket loop**:
The part of the Pipeline that runs without the Builder: Build, then Review, back to Build until the Ticket passes or gives up.
_Avoid_: overnight loop, agent loop, the loop

**Review area**:
One of five areas every Ticket is checked in: Performance, Accessibility, Privacy & legal, Visibility, Code & security.
_Avoid_: category, gate

**Review check**:
One measurement in a Review area that passes or fails with a reason, made by a tool rather than by a model's opinion.
_Avoid_: predicate, audit, gate, lint

**Locale pack**:
An opt-in set of Review checks for one country's law, switched on at Kickoff when the Site's operator or Visitors are there.
_Avoid_: legal pack, compliance module

**Design handoff**:
The one folder the Design Stage commits, whichever design tool was used, and the only design input the Ticket loop builds from.
_Avoid_: mockup, design export, Figma file

**Pass**:
The outcome of a Ticket whose Review checks all succeed.
_Avoid_: green, done, merged

**Measure**:
The Stage that measures both the Site, through what Visitors experience, and the Factory, through Run reports, and proposes Requests from both.
_Avoid_: monitoring, analytics, retro

**Run report**:
The record of how one run of the Ticket loop went: attempts, fix rounds, parked Tickets with their reasons, flaky tests, time spent waiting on rate limits, and which Review checks failed.
_Avoid_: night report, loop report, log

**Factory feedback**:
An anonymised summary of Run reports that the Builder chooses to send to the Factory's maintainers after seeing exactly what it contains.
_Avoid_: telemetry, analytics, crash report

**Preview**:
A non-public copy of the Site that the Builder reads at Approve.
_Avoid_: staging, draft

**Approve**:
The Builder reading a Spec's Preview and merging its pull request, which is what lets the Spec reach Publish.
_Avoid_: sign-off, accept, release
