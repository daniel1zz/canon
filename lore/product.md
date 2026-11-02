---
title: Lore
---
# Lore

## Purpose

Shared memory and coordination for one project that is developed almost entirely by AI, by many concurrent sessions, unattended after the opening phase. Humans set direction and answer only the questions reserved for them.

## Users

- AI sessions (Claude Code and similar) working on the project, often several at once.
- The 3-5 people who own the project's direction.

## Promises

Everything in lore exists to keep one of these true. A mechanism that keeps none of them is removed.

- **P1 Current truth.** At any time an AI can read what the product must do now from one place (`lore/rules`), and it matches the code on main.
- **P2 Why.** The reasoning behind every non-trivial decision can be found later (`lore/decisions`).
- **P3 Continuity.** A new session picks up unfinished work without a human re-briefing it (changes, handoffs, `lore brief`).
- **P4 Safe concurrency.** Sessions working at once never lose work, overwrite each other, or break main (claims, landing queue, floor, compare-and-swap of main).
- **P5 Honest snapshot.** Documents and code on main agree: no dangling references, every rule traced to the tests that decide it (`lore check`).
- **P6 Traceable and self-improving.** Who changed what and why is recorded (git, coordination events); problems become GitHub issues; every check records why it refused so its precision can be measured.
- **P7 Humans decide only what is reserved.** Direction and reserved questions go to `lore human`; nothing else waits for a person.

## Non-goals

- Several machines working on one project at once (coordination state is per checkout).
- A web dashboard or HTTP API: humans read the files in the repo or on GitHub.
- Checks on how an agent works. Lore checks outcomes at two boundaries only: a coordination write and a landing.
