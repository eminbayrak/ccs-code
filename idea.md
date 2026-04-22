# PRINT-AGENT

### Multi-Agent CLI Tool — Design Document

_Print / Billing Team · Internal Developer Tool_

---

|          |                                        |
| -------- | -------------------------------------- |
| Status   | Draft                                  |
| Version  | 0.1                                    |
| Author   | Print/Billing Team                     |
| Audience | Engineering Team + Engineering Manager |

---

## The Problem

Our team uses Jira for tickets, GitHub for code, and separate AI chat tools for assistance. None of these systems talk to each other. Every developer context-switches manually between them — copying ticket details into a chat window, pasting code back into the IDE, manually updating ticket status after opening a PR.

Our engineering manager has no automated view of sprint health. Writing the weekly standup summary, checking PR status, and identifying blocked tickets all happen manually.

Existing solutions — Atlassian's built-in bot, GitHub Copilot, company chat platforms — each solve one piece in isolation. None of them reason across systems simultaneously. None of them carry knowledge of our specific team's codebase, patterns, or workflow.

---

## The Idea

A CLI tool called `print-agent` that a team member runs with a single command. Behind that command, a pipeline of specialized AI agents kicks off — each focused on one job, passing its output to the next agent, until the task is complete.

The key distinction from a regular AI chat tool: you do not manage a conversation. You give it a goal, it works through the steps, and it stops at the right moment to ask for your approval before doing anything irreversible.

---

## The Two Use Cases

### For Developers — The Dev Pipeline

A developer has a Jira ticket. Instead of reading the ticket, figuring out what to build, writing the code, writing tests, opening a PR, and updating the ticket manually — they run one command with the ticket ID.

The pipeline takes it from there:

- Reads the ticket and understands what needs to be built
- Looks at the actual codebase to understand how the team writes code
- Generates code that matches the team's existing style and patterns
- Writes unit tests that cover every acceptance criteria item on the ticket
- **Stops and waits for the developer to review everything**
- Only after the developer approves — opens a GitHub PR and updates the Jira ticket

The human is in control at every irreversible step. The pipeline handles the repetitive work in between.

---

### For the Engineering Manager — The Morning Briefing

Every morning the manager needs to know: what is the state of the sprint, what is blocked, what shipped yesterday, what needs attention today. Currently this requires manually checking Jira, checking GitHub, and mentally connecting the dots between them.

The pipeline does this automatically:

- Pulls the current sprint from Jira — in progress tickets, blocked tickets, overdue items
- Pulls GitHub — open PRs, PRs waiting more than a day for review, what merged recently
- Looks for mismatches between the two — a ticket marked done with no PR, a PR open for days with no reviewer assigned
- Writes a plain-language morning brief summarising all of it with a clear list of what needs attention today

One command. The manager gets a written briefing from their actual live data — not a generic AI summary, but one grounded in what is actually happening in the team's tools right now.

---

## What Makes It Different

**It reasons across systems simultaneously.**
The company chat platform knows Jira if you paste a ticket into it. The Atlassian bot knows Jira natively. GitHub Copilot knows code. None of them connect all three at once. This tool reads Jira and GitHub together and finds things that only become visible when you look at both — like a ticket that has been "in progress" for 8 days with zero commits in the last week.

**It knows our team specifically.**
When it generates code, it reads our actual codebase first. It follows our naming conventions, our file structure, our existing patterns. The output is not generic AI code — it looks like code written by someone who has been on the team for a while.

**The workflow is the product.**
You do not type prompts. You run a command and the agents handle the steps. The human only appears at the moment a decision matters — reviewing code before it reaches GitHub, or reading the briefing and deciding what to act on.

---

## What This Is Not

- Not a replacement for developers — a human reviews everything before it reaches the shared codebase
- Not a replacement for Jira or GitHub — it reads and writes to them, it does not replace them
- Not autonomous — it stops and asks before doing anything that cannot be undone
- Not a generic tool — it is built specifically for the Print/Billing team's workflow

---

## Open Questions

- Should the morning briefing post automatically to the team's chat channel, or stay as something the manager runs on demand?
- Should developers be able to reject individual parts of the generated output — for example accept the code but reject the tests — or is it all or nothing?
- Who owns this tool if the original author moves to another team?
- Should there be a feedback mechanism — if a generated PR gets rejected in code review, does that inform future runs?

---

_PRINT-AGENT · Print/Billing Team · Internal Document_
