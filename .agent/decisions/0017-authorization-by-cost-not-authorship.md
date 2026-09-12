# ADR 0017: Authorization Follows Cost, Reversibility, Exposure and Origin — Not Authorship

Date: 2026-08-28 · revised 2026-09-06

## Status

Accepted.

## Context

Authorship alone does not distinguish a reversible Project-internal write
from exposure, spending, self-modification, or a change to Project direction.
Repeated approval of low-risk work obscures the decisions that need attention.
The product division of labour is that Agents advance authorized work while a
person steers direction and reviews outcomes. Direct application therefore
requires real origin controls, bounds, auditability, and undo, not fewer
protections for unattended or high-impact writes.

## Decision

### 1. The hard-gate list is exhaustive and reasoned

A write requires a person's approval per instance when, and only when, it is
one of:

| Class | What | Governing rule |
| --- | --- | --- |
| Self-modification | the Agent's own capabilities, policies, prompts | B20, ADR 0009 |
| Long-term belief with widened reach | memory writes that widen visibility, raise sensitivity, concern another person, or replace content authored by a person or another Agent | ADR 0003 |
| Real checkout | code patches to a governed workspace | B19, ADR 0016 |
| Exposure | egress, publication, sharing across Spaces or from personal to team | ADR 0013 |
| Money | spend above the bounded default of any pipeline | this ADR §3 |
| Credentials and deployment | | ADR 0008, B43 |
| Direction | the Project Brief goal | ADR 0014 §5, ADR 0019 |

An action that registers as a proposal must name, at its registration, which
row of this table it falls under. An action that names none is not a proposal
action.

**One named exception, and only one: an Agent's persona entry.** A persona is
rendered into that Agent's own prompt, so on its face it reads as
self-modification — but it is a `memory_entries` row with Memory's versioning,
provenance, archive and restore, so it belongs to the *second* row of this
table — long-term belief, governed by
[ADR 0003](0003-memory-proposal-flow.md) — and not to the first. That row
defers to ADR 0003 for when the gate applies, and ADR 0003 §5 is where the
answer is: a persona write is gated per instance in a `manual`-origin Run, and
ungated only in unattended work the Agent's **own owner** set going. Unattended
work somebody else set up is gated like a turn. It is the only entry in this
table for which the "and only when" above is read through the governing rule
rather than applied to every write of that kind.

The self-modification row keeps its meaning: capabilities, policies, and
authored prompt artifacts, through the B20 / ADR 0009 capability lifecycle. A
persona entry is none of those — it has no manifest, no code, no tests, and
nothing about it enters that lifecycle. What makes the difference defensible is
that ADR 0003 §5 gates it *harder* than authorship would in every case that
matters here: a person in a turn cannot rewrite it directly, not even the
owner, and nobody but the owner can reach it by scheduling work either.

Explicit checkpoints placed by a plan or workflow author also remain binding:
`plan_checkpoint` and `workflow_execution_checkpoint` are requested stops, not
author-based default gates. `plan_review` is a direction gate and
`workflow_save` is self-modification.

### 2. Everything else is governed by origin and bounds

For a Project-internal write outside §1 — creating or revising an Inquiry
Thread, recording a conclusion, creating or moving a Task, starting a bounded
acquisition, adopting a recorded next step, and the like — there is no
proposal. Two mechanisms replace it:

- **Trigger origin.** A write from a run whose origin is a person in a
  conversation (`manual`) executes. A write from any other origin
  (scheduled, delegated from an unattended root, automated) is
  `require_approval`. `ruleUnattendedProjectWrite` enforces the origin boundary for writes in this
  class.

  **The persona exception, and its reasoning.** An Agent's persona entry
  ([ADR 0003](0003-memory-proposal-flow.md) §5) is the one write whose origin
  test runs the other way round: a `manual` turn proposes it, and the Agent
  owner's own unattended work applies it. The rule above assumes a person in a
  conversation is the authorization — which holds for a Project-internal write,
  whose reach is the Project the person is already in. A persona is delivered
  in every Room and every conversation this Agent has, so "a person asked in a
  turn" is exactly the input that must not carry that reach: any member of any
  Room the Agent sits in could otherwise rewrite what every other member's
  turns will see. The case that applies is not a person's request at all — it
  is the Agent concluding something about itself while doing work its owner set
  up — and it is bounded by everything ADR 0003 §4 and §5 require: one revision
  per Run, one active persona per Agent, a record for the Agent's owner
  carrying what it replaced as well as what it now says, and a one-step
  reversal that puts the previous version back.

  Unattended is not unowned, so the inversion stops at the owner. Work somebody
  else scheduled against this Agent — another member's Automation, their
  autonomy tick, a job serving their plan — reaches every Room the Agent sits
  in exactly as their turn would, and ADR 0003 §5's fourth row gives it exactly
  what their turn would get: a proposal pending for the owner.

  So the exemption is narrow by construction: it applies to `memory_type =
  'persona'` on an `agent`-scope entry and to nothing else, and the policy
  layer must scope it that narrowly rather than exempting `memory.write` as a
  whole.
- **Bounds.** Every fan-out and every spend has a limit set before the work
  runs, the overflow is queued or offered rather than refused, and the limit
  is visible in the message that announces the work. A decomposition creates
  at most **5** Threads or Tasks per turn; an acquisition reads at most
  `SCREENING_AUTO_CONTINUE_CORPUS_LIMIT` items; an incremental update takes at
  most the same and defers the rest. A bound the caller may raise is an
  input on the action, never a server constant alone. The five-object safety
  ceiling is not a pacing target: Project conversation behavior follows
  [ADR 0019](0019-project-has-no-type-field.md), at most one object unless the
  user requests a plan/decomposition, then at most three. That narrower pacing
  does not replace execution bounds with prompt text.

A `follow_up_task` may still be drafted as a proposal envelope to carry Run
context taint and egress requirements. After a successful user-requested Run,
the governed path applies it for the user when eligible; failed or unattended
Runs leave it pending. A proposal record is not itself a requirement for an
additional human decision.

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
  ("split into 3 sub-questions") that expands.
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
  entry; the person sees the bounded set of new Threads and prunes if they
  disagree. Conversation pacing follows ADR 0019.
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
- `memory.write` stays in `ORIGIN_GATED_PROJECT_WRITES`. The persona exception
  is expressed as a narrower condition inside that rule — a persona write on an
  `agent`-scope entry — never by removing the action from the gated set, which
  would relax the origin boundary for every other memory write with it.

## Non-goals

- No change to ADR 0008, 0013, 0016, B19, B20, B43.
- No automatic write from an unattended origin, with the single named
  exception of an Agent's persona entry (§1, §2). Origin gating is not
  otherwise relaxed, and the exception is not a precedent for a second one:
  another write that wants it has to earn its own row here.
- No inline editing of proposals in the Room (unchanged from the
  conversational-advancement decisions).

## Enablement condition

A default may switch to direct application only after its review-after,
undo, bounds, and origin checks exist. This condition applies to each write path.

## Revision history

- **2026-08-28** — original: the exhaustive hard-gate list, origin-and-bounds
  governance for everything else, bounded spend, review-after with undo, and
  `gatedProposalAction`.
- **2026-09-06** — named the one exception to §1's self-modification row and
  §2's origin gate: an Agent's persona entry, governed by ADR 0003 §5, with
  the reasoning for the inversion and the requirement that the policy layer
  scope the exemption to persona rather than to `memory.write`.
- **2026-09-11** — narrowed that exception to its reason: the origin test runs
  the other way round only for unattended work the Agent's **own owner** set
  going. Work anybody else scheduled is gated like their turn, per ADR 0003 §5's
  fourth row. Read as "any unattended origin applies", the exception had handed
  the reach it exists to protect to whoever could schedule the Agent.
