# ADR 0003: Agent Memory Writes Are Bounded and Reviewable, Not Pre-Approved

Date: 2026-05 (original) · revised 2026-09-06

## Status

Accepted.

## Context

Memory needs provenance, versioning, visibility controls, and a practical way
for a person to inspect and reverse writes. Requiring separate approval for
every low-risk entry creates a repetitive queue that obscures the decisions
that actually widen reach. This ADR keeps approval for those decisions and
requires bounded, attributable, reversible writes for the rest.

Memory also has to answer a second question the original decision did not: an
Agent that runs on several machines, in several Rooms and several
conversations still has to be *one* Agent. What it learned about itself, and
what it learned in a Room, are its own — not the machine's, not the CLI
profile's, and not automatically everyone's.

## Decision

**Agents write memory within bounds and under review-after.** The conditions
in section 1 and the Agent's `requires_proposal` policy determine which writes
need approval in advance. This applies ADR 0017 to memory.

### 1. Gated writes (a proposal, approved per instance)

A memory write is a proposal when it would:

- widen `visibility` (private → space-shared or team), or raise
  `sensitivity_level` above `normal`;
- widen an `agent`-scope entry's reach — promoting a note to Project Memory is
  the **only** way agent-scope content reaches a wider audience (section 4);
- concern another person (`subject_user_id` is not the acting user);
- replace or archive content a person authored (`created_by` is a user), or
  content another Agent authored — an Agent revises what it wrote, and
  someone else's record of the same person is the person's call;
- originate from any trigger origin other than a person in a conversation
  (`manual`) — post-session reflection, activity-to-memory pipelines,
  consolidation and maintenance jobs, and every external import keep the
  proposal flow unchanged. **Persona is the one exception**, for the reason
  section 5 gives;
- revise an Agent's persona in a `manual`-origin Run (section 5);
- be a `memory_maintenance_packet` (bulk change by construction).

### 2. Bounded writes (applied directly, as a new version)

Everything else — an Agent in a `manual`-origin session creating a personal,
normal-sensitivity entry, or revising one it authored, plus the one write whose
origin test runs the other way round (a persona revision from an unattended
origin, §5) — applies directly, subject to:

- **always a new version**, never in place: the prior version is retained
  and restoration archives the superseding version before restoring the prior
  one; two versions on the same chain must not be active together;
- **provenance is mandatory**: session, run, rationale, and `created_by =
  agent:<id>`; a write without them is rejected at the applier, not
  approved by a person;
- **no count limit.** A cap on how many memories a session may write was
  considered and rejected: memory's risks are reach and quality, both
  governed above and by pruning, not volume — and a cap whose overflow
  becomes proposals reinstates the human queue this ADR removes. The only
  volume mechanism is an operational circuit breaker: a person's writing,
  past an anomalous number of entries, is paused and flagged as a fault to
  investigate, never re-routed to a person to approve. It counts per person
  rather than per session because a Room conversation is one session shared
  by its members, and the way to clear it — archiving what was written — is
  only available to the owner of those entries. It counts within the session,
  or within the Run where there is none: a conversation outside a Room has no
  session. Count active entries plus pending proposals for that person and
  scope; ordinary revision does not increase the count, and archiving reduces it;
- **an Agent's memory policy may still opt into `requires_proposal`**, which
  requires proposal approval for that Agent even when the other conditions
  permit direct application. The canonical applier enforces it.

An `agent`-scope write (section 4) is bounded by the same shape plus its own
scope bounds: the entry's `agent_id` is the Agent executing the Run, its
`owner_user_id` is that Agent's owner, its visibility is private and its
sensitivity normal, and a note carries the Room it was learned in — or no Room
when it was learned in direct chat with the owner, which is the only case where
`origin_room_id` is null for a note. For this scope the circuit breaker counts
under the **Agent's owner**, not under the person in the turn: the owner is who
archives these entries, and an unattended Run has no person in the turn to
count against.

### 3. The counterpart: memory is observable and undoable

Direct writes are conditional on the person being able to see and reverse
them without ceremony:

- the Memory page shows every entry's provenance and version chain, filters
  by "written by an Agent since I last looked" and by owning Agent, and offers **archive and
  restore as direct actions for the person** — a person's own archive is not
  a proposal;
- each bounded write made during Project work appears in that Project's
  updates with a one-step undo (`archive_memory`); a write in a session with
  no Project is read on the Memory page, which is the only surface a
  Space-wide feed would have duplicated;
- a persona revision applied without a decision (section 5) is recorded where
  the write happened, carrying what it replaced as well as what it now says,
  with a one-step reversal that retires the new version and brings the previous
  one back — an Agent must always have some persona, so archiving alone is not
  a reversal here. In a Run with a Project that is the Project's updates; in a
  Run without one a private, content-free Activity Inbox pointer takes the
  owner to the Memory page. There is no content-bearing Space-wide feed;
- the user's stated line stands: memory is never a black box.

Runtime continuity checkpoints (ADR 0014) remain derived reference context
and grant no authority to write memory; promotion from a checkpoint is a
write under this ADR.

### 4. The `agent` scope: what an Agent knows about itself and its Room

Memory has a third scope beside `user` and `project`. In it `agent_id` is the
**ownership key** — the one place that column is more than producing
provenance — and `owner_user_id` is the Agent's owner, who archives, restores
and reviews. This is not a second store beside Memory: it is Memory, with the
same versioning, provenance, retrieval, visibility and archive/restore.

Nor is it a second store beside `evolvable_assets`, which until now held
everything an Agent learned. The line between them is *what kind of thing* the
learning is, not who learned it: `evolvable_assets` holds **how an Agent
works** — capability manifests, code, prompts and tests, changed through the
B20 / ADR 0009 lifecycle. The `agent` scope holds **what an Agent knows and who
it has become**: prose an Agent wrote about itself or about a Room, versioned,
retrievable, archivable, with no manifest and nothing to test. A capability
change stays in `evolvable_assets` and is not a memory write.

Two kinds of entry, and no more:

- a **note** (`memory_type` in `note`, `decision`, `lesson`) carries the Room
  it was learned in (`origin_room_id`), or none when the Run speaks in no Room
  and the person who set it going is the Agent's owner — the direct-chat case,
  and the only one the applier accepts a Room-less note from. It is delivered to the Agent only where everyone who
  may read the current Room's conversations may also read the origin Room's.
  "May read" is asked of the Room read gate
  (`access/contentAccessSql.ts` `roomConversationReadAccessSql`), never of the
  roster: a mainline's audience is every Project reader, of whom the roster
  holds only those who have opened it, and a limited Room's is its roster
  intersected with Project readability (ADR 0018, `modules/rooms.md`). An
  audience that could not have seen the conversation the note came from never
  receives the note. A note never crosses a Room; anything that should reach a
  wider audience is *promoted* to Project Memory through the proposal path in
  section 1;
- a **persona** (`memory_type = persona`) is what the Agent has learned about
  itself. One active entry per Agent, no origin Room, delivered everywhere,
  and therefore by rule free of Project facts. A revision is a new version on
  the chain; a rollback is a restore.

  The persona is the one agent-scope channel that does cross a Room, and
  nothing mechanical stops a revision written during a limited Room's turn from
  carrying that Room's content into every other Room. That residual risk is
  **accepted, not solved**, and what bounds it is §5 plus §3: no person in a
  turn can write it, at most one revision per Run, and the owner is notified
  with the diff and a one-step restore. "Free of Project facts" is a rule the
  Agent is told and the owner enforces on review — not a filter. If it turns
  out to leak in practice, the answer is to narrow what may be written into a
  persona, not to widen the audience filter, which by construction cannot help
  an entry that has no origin Room.

The same two Agent tools (`memory.remember`, `memory.revise`) write this scope;
no third action is added. What that widens is worth stating, because the reason
those two are granted in any conversation — Room or not — was that "what it
writes is private to the speaker and touches no Project"
(`architecture/SYSTEM_ACTIONS.md`). An agent-scope entry is not private to the
speaker: it is the Agent's, readable by the Agent's owner, and re-delivered into
other conversations. It still touches no Project and still crosses no audience
that could not already see it — the note's origin-Room filter is what replaces
"private to the speaker" here, and the persona's gate is §5. That is why the
tool surface stays as it is rather than acquiring a Room-bound twin.

An Agent with no owner has no `agent` scope. `agents.owner_user_id` is nullable
and is genuinely null for the Space and Project Assistants, which are
`space_shared`; a private entry with no owner cannot be stored at all
(`ck_memory_entries_private_owner`), and §5's table cannot be evaluated without
one. Such an Agent's writes stay in the `user` scope they use today, and the
applier refuses an agent-scope write from it with a reason the Agent can read
rather than inventing an owner.

The owner's static `agents.role_instruction` is a different field with a
different author and is not touched by any of this: the person sets the role,
the Agent evolves the persona, and the prompt renders role first.

### 5. Who may change a persona is decided by who triggered the Run

A persona entry is delivered in every Room and every conversation, so a person
who can talk to an Agent must not be able to rewrite what every other person's
turns will see. The rule is enforced at the applier from `runs.trigger_origin`
and `runs.instructed_by_user_id` against `agents.owner_user_id` — never from
the prompt, which is the thing being defended against:

| Run trigger | Persona write |
|---|---|
| `manual`, instructed by the Agent's owner | a proposal decided in the turn; applied on accept |
| `manual`, instructed by anyone else | a proposal pending for the owner; nothing applied, and neither the preview nor its content is projected to the instructing person |
| `automation`, `autonomous`, `job`, `delegation`, `system` | applied directly as a new version, with the section 3 notification and one-step restore |

The origin read here is the **effective** one: a Run delegated from another
Agent carries `delegation`, but the question is whether a *person* asked, and
for a delegated Run the answer is on its root. A `delegation` Run under a
`manual` root is therefore row one or two, not row three — otherwise one hop of
`agent.delegate` would be a prompt-reachable way to apply a persona change with
nobody deciding it, which is the thing this table exists to prevent. The policy
gate resolves the same way, so the two cannot disagree about one Run.

The third row is the deliberate exception to section 1's "any origin other
than `manual` is a proposal", and the same exception is the one
[ADR 0017](0017-authorization-by-cost-not-authorship.md) §1 and §2 name: a
persona is governed as a memory write under this ADR rather than as
self-modification, and it is the single write whose origin gate runs the other
way round. The policy layer scopes that exemption to a persona write on an
`agent`-scope entry produced specifically by `memory.remember` or
`memory.revise`; `memory.write` stays origin-gated for everything else.

The reason the two rows are the other way round
from everywhere else: a person in a turn asking for a change is exactly the
input that must not be trusted with reach this wide, while an Agent concluding
something about itself outside anyone's turn is the case the notification and
the restore already cover. "Alice asked the Agent to change" and "the Agent
concluded on its own during Alice's turn" are indistinguishable at the
mechanism level and do not need to be: the second row covers both.

"The instructing person cannot approve it" needs a mechanism, because proposal
decision authority in this codebase is role-based (`required_approver_role`),
and a Space owner or admin who instructs someone else's Agent satisfies any
role a persona proposal could require. A persona proposal is therefore decided
by the Agent's **owner alone**, by owner identity and not by role — the applier
and the review surface both check it, and no role elevation substitutes. The
instructing member is shown nothing in the Room: they cannot decide it, and a
pending card they cannot act on is noise.

At most one persona **write** per Run — the count is of writes, so a first
persona and a revision are the same budget — and at most one active persona per
Agent.

### 6. A CLI's own working memory is outside Memory

Claude Code, Codex and OpenCode keep auto-memory in their own state
directories on the executing machine. That state is scratch, delegated to the
runtime: Rainver does not read it, import it, synchronize it in either
direction, review it, or promote it into `memory_entries`, and it is never
Memory's authority for anything. Nor does Rainver render Rainver state into a
vendor context file (`CLAUDE.md`, `AGENTS.md`) — ADR 0004's boundary and ADR
0014's retired list both stand.

What keeps that scratch from crossing a boundary is not Memory but the
substrate: the CLI's state root **must be** scoped to one Agent and one
container, so that two Agents on one machine and one Agent in two Rooms never
share it. [`modules/hosts.md`](../modules/hosts.md) is the authority on whether
it is, and it says what the profile key is today. Memory's own answer to "what
did this Agent learn" is section 4, and it is the only one.

## Consequences

- Room and chat memory-write actions land in the canonical applier under
  sections 1, 2, 4 and 5; adapters, jobs, and routes do not insert memory
  directly.
- The proposal applier remains the only writer of `memory_entries`; §2
  writes go through it with the acting Agent as author and no approver, and
  the applier enforces §1, §2, §4 and §5's conditions — no adapter, job or
  route inserts directly.
- The audience rule in §4 is a **read** gate as well as a write bound, and it
  has one door. Agent-scope entries are excluded from the person-facing
  retrieval index entirely — memory search runs *as* the instructing person
  from inside a turn, so indexing them would return a note from a limited Room
  into any other Room that asked. They reach the Agent through their own
  candidate query, which applies the subset test inside it rather than
  filtering afterwards.
- External chat capture still creates Activity records first (B12).
- Memory quality is governed by versioning, provenance and pruning rather
  than by pre-approval; a bad memory is found and reversed, not prevented by
  a queue nobody reads.
- B10 is rewritten to state this decision.

## Revision history

- **2026-05** — original: gated versus bounded writes, the circuit breaker
  instead of a write cap, and the observable/undoable counterpart.
- **2026-09-06** — added the `agent` scope and its two entry types (§4), the
  trigger-based persona rule (§5, and its gate in §1), the origin-Room
  audience rule as a read gate with promotion to Project Memory as the only
  widening path, and the statement that a CLI's own auto-memory is outside
  Memory and never imported (§6).
- **2026-09-06 (later)** — the note audience is measured by the Room read gate
  rather than the roster: measuring by roster understated a mainline, whose
  members are enrolled on first open, and delivered a limited Room's note into
  a mainline nobody but the owner had opened yet. Also: an agent-scope entry is
  revisable only by the Agent it belongs to, on the direct and the proposal
  route alike, even when the same person owns both Agents.
