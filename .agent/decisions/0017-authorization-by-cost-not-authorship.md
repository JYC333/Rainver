# ADR 0017: Authorization Follows Cost, Reversibility, Exposure and Origin — Not Authorship

Date: 2026-08-28

## Status

Accepted.

## Context

The repository governs an Agent's durable writes by **who is writing**: the
`proposalAction()` helper makes "draft a proposal for a person to approve"
the default shape of an Agent action, and most Project-internal writes took
that default. Nothing decided this; it was a helper's default that was
followed.

Two things showed the default is wrong for the product ADR 0010 describes.

First, the repository already contradicts it. The five Project work actions
(`task.create`, `task.report`, `task.handoff`, `task.advance_stage`,
`task.request_review`) write directly, with the recorded reasoning that *a
person asking in the turn is the authorization* and that "a decomposition
drafted into proposals a person then approves one by one is the same decision
taken twice" (`architecture/SYSTEM_ACTIONS.md`). `inquiry.propose_thread`
does the same kind of work — splitting one thing into several — and still
produces one proposal per piece. One Room turn produced six pending
`inquiry_thread_create` cards for one decision; the person's own archive of a
memory entry they created also raises a proposal for themself to approve.

Second, the direction. The product is an Agent that advances Projects with a
person steering direction and reviewing outcomes
(`project-conversational-advancement` decisions, 2026-08-16: "structure is a
compass, not a gate"). Under that division of labour, per-write approval
degrades into a rubber stamp: a person who approves six identical cards
without reading them will approve the seventh, which was the one that needed
reading. Per-write approval therefore weakens the gate it was meant to be, on
exactly the writes that matter.

What the existing hard gates actually protect turns out not to be authorship
at all: ADR 0003 protects *what the Agent believes long-term*; B19 protects a
real code checkout; B20 protects the Agent's own capabilities; ADR 0013
protects against unintended exposure across people; credentials, egress and
deployment protect money and the outside world. Every one is about
**irreversibility, exposure, self-modification, or cost**. None is about who
typed the change.

## Decision

### 1. The hard-gate list is exhaustive and reasoned

A write requires a person's approval per instance when, and only when, it is
one of:

| Class | What | Governing rule |
| --- | --- | --- |
| Self-modification | the Agent's own capabilities, policies, prompts | B20, ADR 0009 |
| Long-term belief with widened reach | memory writes that widen visibility, raise sensitivity, concern another person, or replace human-authored content | ADR 0003 (rewritten) |
| Real checkout | code patches to a governed workspace | B19, ADR 0016 |
| Exposure | egress, publication, sharing across Spaces or from personal to team | ADR 0013, B25–B27 |
| Money | spend above the bounded default of any pipeline | this ADR §3 |
| Credentials and deployment | | ADR 0008, B43 |
| Direction | the Project Brief goal | ADR 0011 |

An action that registers as a proposal must name, at its registration, which
row of this table it falls under. An action that names none is not a proposal
action.

### 2. Everything else is governed by origin and bounds

For a Project-internal write outside §1 — creating or revising an Inquiry
Thread, recording a conclusion, creating or moving a Task, starting a bounded
acquisition, adopting a recorded next step, and the like — there is no
proposal. Two mechanisms replace it:

- **Trigger origin.** A write from a run whose origin is a person in a
  conversation (`manual`) executes. A write from any other origin
  (scheduled, delegated from an unattended root, automated) is
  `require_approval`. This is `ruleUnattendedProjectWrite`, extended from
  its current two actions to every write in this class.
- **Bounds.** Every fan-out and every spend has a limit set before the work
  runs, the overflow is queued or offered rather than refused, and the limit
  is visible in the message that announces the work. A decomposition creates
  at most **5** Threads or Tasks per turn; an acquisition reads at most
  `SCREENING_AUTO_CONTINUE_CORPUS_LIMIT` items; an incremental update takes at
  most the same and defers the rest. A bound the caller may raise is an
  input on the action, never a server constant alone.

### 3. Money is bounded, then asked about — never silently spent

Any pipeline that consumes provider tokens or paid API calls runs its bounded
default without asking and raises **one** proposal for the remainder, made at
the point it can be acted on. Raising the bound is an explicit instruction
from the person; the Agent never raises it on its own initiative.

### 4. The counterpart: review after, with undo

Removing per-write approval is conditional on review-after being real. Before
any default flips:

- **Updates** records every write in §2 with what changed and a per-entry
  archive/undo; writes from one run of one kind fold into one entry
  ("split into 6 sub-questions") that expands.
- **Attention** carries only four things: §1 gates awaiting a decision; §3
  remainder offers; the system's own recorded next step; and writes the Agent
  itself flagged as uncertain. It carries no "please confirm what I already
  did" items.
- **Pulse** shows what is running and how far, and the Project's goal and
  primary question stay in every Room turn's context so drift is visible
  against a fixed reference.

### 5. `proposalAction` stops being a default

The helper is renamed to say what it is (`gatedProposalAction`) and requires
the §1 class as an argument. Actions that no longer qualify are re-registered
as direct actions under §2: `inquiry.propose_thread` → `inquiry.create_thread`,
`inquiry.record_conclusion` → direct, memory creates/updates per ADR 0003.
`inquiry.promote_knowledge`, `project.propose_definition`, source activation
and backfill start, egress review and code patches keep their gate and name
their class.

## Consequences

- One Room turn that splits a question produces zero cards and one Updates
  entry; the person sees six new Threads in backlog and prunes if they
  disagree.
- The Space-level Review page shrinks to the §1 list, which is what a review
  page is for.
- Attention becomes trustworthy: what is there needs a person, so it gets
  read.
- Unattended automation gets no new authority; a scheduled run's Project
  writes still wait for a person.
- BOUNDARIES gains B70 (this decision as a boundary) and B10 is rewritten to
  match ADR 0003; ADR 0011 §6 defers to §4 above for what "needs a person"
  means; `architecture/SYSTEM_ACTIONS.md` restates its durable-writes section
  as the general rule.

## Non-goals

- No change to ADR 0008, 0013, 0016, B19, B20, B43.
- No automatic write from an unattended origin; origin gating is not
  relaxed.
- No inline editing of proposals in the Room (unchanged from the
  conversational-advancement decisions).

## Sequencing

Phase 1 builds §4 (Updates undo, attention classes, folding). Phase 2 flips
§5 defaults and extends origin gating. Phase 3 gives the Agent a memory-write
path under ADR 0003's rewrite — a new capability, not a relaxed gate: today
no Agent can write memory from a conversation at all, so the person has never
been the bottleneck there; nothing has. The order is a rule, not a preference: a default flips only when the
review it displaces has been replaced.

## Revision history

- **2026-08-28** — proposed and accepted the same day.
- **2026-08-28** — implemented across three phases (Inquiry direct writes, the
  Project's readable account and undo, memory's write path), then
  `follow_up_task`: after a Run a person asked for succeeds, its follow-up
  Task is applied for them instead of queued as a card. The proposal is still
  drafted in every case — it is what carries the run's context taint and
  egress requirement, and what a failed or unattended Run correctly leaves
  standing.
  The remaining per-instance gates on the Review page were checked against §1
  and are staying: `plan_review` is direction, `workflow_save` is
  self-modification, and `plan_checkpoint` /
  `workflow_execution_checkpoint` are checkpoints the plan's own author placed
  — a person asking to be stopped there, which is not the authorship-based
  gate this ADR removes.
