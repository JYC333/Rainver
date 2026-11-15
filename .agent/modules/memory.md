# Module: Memory

## Purpose

Memory is scoped long-term knowledge that is either curated and approved by a
person or written by an Agent within ADR 0003's bounds. It is not raw activity,
Runtime Context continuity, a prompt cache, an adapter-owned store, or a copy of
a vendor CLI's own auto-memory.

## Ownership and invariants

- `server/src/modules/memory/` owns Memory read/proposal/apply behavior and its
  Retrieval domain adapter.
- The Memory applier is the only writer of active `memory_entries`, by three
  routes ([ADR 0003](../decisions/0003-memory-proposal-flow.md)): a
  proposal a person approved, an Agent's own bounded write
  (`applyDirect`) that stays private and normal-sensitivity and within its
  scope's bounds — about the person in the turn for a user-scope entry, about
  the Agent itself for an agent-scope one. A person importing a published
  user-memory snapshot also goes through the same repository
  (`applyPublicationImport`): private, normal-sensitivity, attributed to the
  importer, with user-confirmation provenance. The owner changing who may read
  their own entry is the same applier too (`applyOwnerAccessChange`, reached
  from the content-access API): a new version with the same content and
  provenance under the new reach, grants moved with it. No adapter, job or
  route inserts around it.
- Grants follow the active head, and the applier re-checks the audience at
  accept time: only the owner widens a person's entry (moving it into a
  Project or to another owner included), a revision never moves an entry into
  or out of an Agent's scope, and every added reader
  must already read the entry's sources (`memoryAudience.ts`). An accepted
  update that changes nothing writes no version.
- User Memory is human-owned and Project-free. Project Memory is Project-owned
  and shared only through the Project access boundary. Agent Memory
  (`scope_type = 'agent'`) is Agent-owned: there, and only there, `agent_id` is
  the ownership key, with `owner_user_id` naming the Agent's owner, who
  archives, restores and reviews. In every other scope `agent_id` remains
  producing-Agent provenance and never an ownership or read-expansion key.
- An Agent-scope note carries the Room it was learned in (`origin_room_id`, null
  only when the Run speaks in no Room and the person who set it going is the
  Agent's owner, which is the direct-chat case) and is delivered only
  where everyone who may read the current Room's conversations may also read
  that Room's — asked of the Room read gate (`roomConversationReadAccessSql`),
  not of the roster. A note never crosses a Room —
  widening is promotion to Project Memory through the proposal path
  ([ADR 0003](../decisions/0003-memory-proposal-flow.md) §1, §4). An Agent-scope
  persona has no origin Room and is delivered within retained-Project isolation; that it stays free of
  Project facts is a rule the owner enforces on review, not a filter, and ADR
  0003 §4 records the residual risk as accepted.
- An Agent with no owner (`agents.owner_user_id` null — the `space_shared`
  Space and Project Assistants) has no `agent` scope at all; its writes stay in
  the `user` scope, and asking for one is refused with that reason.
- Memory maintenance does not scan the `agent` scope. Those entries are the
  Agent's own record of itself and of a Room, its persona is one entry by
  construction, and a maintenance packet proposing to rewrite either would put
  an Agent's identity into a bulk review nobody reads it as.
- Every read applies Space, status/deletion, owner/visibility/grant, Memory
  scope, and Project membership gates before content leaves the domain.
- Cross-person reads write the shared privacy audit before returning content.
- Memory maintenance may create private report artifacts and review packets; it
  never writes active Memory directly.

## Runtime Context boundary

Memory search is a read-only candidate authority. Runtime Context may acquire
Memory candidates for the instructing user and exact Project scope, but it
revalidates the canonical rows and immutable execution-control snapshot before
persisting an accepted Delivery. Adapters cannot query Memory directly.

Accepted source ownership/visibility contributes to the Run taint summary used
as an output-publication ceiling. Safe Invocation Snapshots retain canonical
source refs for audit and content-demotion disclosure. Context Events and
checkpoints never promote content into Memory; promotion is a write under ADR
0003, and one that carries no rationale of its own is a proposal.

Context compilation, snapshots, manual attachments, and vendor context files
are not Memory responsibilities. Do not reintroduce them here.

## Main write flows

**A person, through the public API.** `POST /memory` and `PATCH /memory/{id}`
create a pending create/update proposal; proposal review verifies placement,
source trust, provenance and policy; the applier writes the canonical version
and its provenance links. `DELETE /memory/{id}` archives the caller's **own**
entry outright and answers 200 with it (ADR 0003 §3 — a proposal there was
the person filing a request with themselves); someone else's still creates an
archive proposal and answers 202. `POST /memory/{id}/restore` is the reverse,
owner-only, and also restores the version a revision replaced once no newer
version is active. Both lock the entry row and serialize on the version chain
(a transaction advisory lock on its root), and the write is refused if the
status moved since it was read: two restores on one chain cannot both pass
the active-head check, and an owner's archive ordered behind an Agent's
in-flight revision archives nothing it did not read. An update proposal's
`highly_restricted` rule reads the target's own visibility, since the command
may not carry one.

**An Agent, in a person's turn.** `memory.remember` / `memory.revise` go
through `applyDirect`: a new version, `created_by = agent:<id>`,
`approved_by = null`, `created_from_proposal_id = null`, and one `run`
provenance link carrying the rationale and the session. It is bounded rather
than pre-approved — private, normal-sensitivity, about the acting person, and
a revision only of what the Agent itself wrote and the person owns. Anything
that would change reach becomes a proposal instead of an error, and takes the
review above, where the person's accept is what the source-monitoring gate
reads as confirmation. The direct route does not run that gate: what stands
in for it is §2's bounds — the write is private to one person, versioned,
attributable, and archived in one action from the Memory page or the
Project's updates.

**An Agent, about itself or its Room**
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §4–§5). The same two
tools write the `agent` scope, and `memory_type` is what decides which scope a
write lands in rather than a second field: `note`, `decision`, `lesson` and
`persona` are the Agent's own, everything else is about the person in the turn.
A **note**
(`note`, `decision`, `lesson`) applies directly under the bounds above plus
its own: `agent_id` is the Agent executing the Run,
`owner_user_id` is that Agent's owner, and `origin_room_id` is the Run's Room —
or null when the Run speaks in no Room and the person who set it going is the
Agent's owner — the direct-chat case, and the only one the applier accepts a
Room-less note from. A **persona** is the one
entry type whose gate is the Run's trigger rather than its reach
([ADR 0003](../decisions/0003-memory-proposal-flow.md) §5): read from
the **root** Run's `trigger_origin` and `instructed_by_user_id` together
(`systemActions/effectiveRunTrigger.ts`, so one hop of delegation changes
nothing), never from the prompt.
The owner's own `manual` turn produces a proposal decided in that turn; anyone
else's `manual` turn produces a proposal only the owner can accept. Its preview
is projected from the proposal authority for that owner and is never stored in
the shared Room message, so the instructing member receives nothing. An
unattended origin applies directly when the person responsible for that work is
the Agent's owner, and otherwise leaves the owner the same proposal — unattended
is not unowned, and a persona reaches every Room whoever scheduled the Run. A **revision** made that way is
recorded where the write happened — `agent.persona_revised` in the Project's
updates when the Run had a Project, carrying what it replaced and a one-step
`restore_memory`; outside a Project, a private content-free Activity Inbox
pointer takes the owner to the Memory page, where the same reversal is
`POST /memory/:id/revert`. A first persona is an ordinary `memory.remembered`:
it replaced nothing, so there is nothing to put back and archiving is the
reversal. There is no shared or content-bearing Space-wide feed; the pointer is
private and contains identifiers only. At most one persona **write** per Run —
a create counts — and at most one active persona per Agent.

The Memory list accepts `agent_id`, and the page offers a named Agent selector;
an owner with several Agents can distinguish and filter each one's memories
instead of seeing only the broader `scope_type = agent` set.

Delivery is where the audience rule bites: `listAgentMemoryForDispatch`
(`memory/agentMemoryDelivery.ts`) returns an Agent's own memory for one
audience, and the subset test runs inside that candidate query rather than
after it, so an entry the audience must not have never leaves the database. The
audience is **asked of the read gate**, not read off the roster:
`roomConversationReadAccessSql` says a mainline is readable by every Project
reader (its roster holds only those who have opened it) and a limited Room by
its roster intersected with Project readability, and the query enumerates the
Space's active members through that predicate for both the target and the
origin. It is computed at dispatch, against the **current** answer, because ADR
0018 makes that the answer to who may see a Room. A direct chat is an audience
of one — a note comes back there when that person may still read its Room, and
its own notes have no Room and always do. A Room nobody may read receives
nothing across, because its transcript outlives the emptiness. A persona has no
Room audience subset filter. Retained-Project isolation adds a stricter bound:
an isolated Run cannot write global persona (manual or unattended), nor create
or accept a persona proposal. `personaIsolation.ts` reads canonical Run scope
and locks the Agent at the canonical writer; approval cannot override this bound.
Dispatch also excludes persona whose Run provenance names another Project,
including copied revision provenance, and withholds all persona in isolated Rooms.

An agent-scope entry is revisable only by the Agent it belongs to. The applier
refuses another Agent's revision outright rather than as a reach question a
proposal could settle, the proposal repository refuses an Agent-origin update
proposal aimed at another Agent's entry, and a proposal-applied revision keeps
`agent_id` and `created_by` as the entry's own Agent — so two Agents under one
owner cannot cross a version chain, and an accept cannot leave one of them with
no persona.

This is the **only** door: agent-scope entries are excluded from the
person-facing retrieval index outright (`retrievalAdapter.ts`), because memory
search runs as the instructing person from inside a turn and would otherwise
return a note from a limited Room into any other, and they are outside Space
oversight for the same reason — an admin who may not read the origin Room's
conversations is not the audience a note was delivered to. Rendering what this returns into a
prompt is the dispatch path's job: `agentGroups/agentIdentityPrompt.ts` does
it, on a Room turn, a Room delegation and a direct chat. A vendor
CLI's own auto-memory is not part of either flow and is never read, imported or
written back.

Retrieval projections are derived and rebuildable in both flows; they never
become the canonical Memory store.

## Related files

- `.agent/architecture/MEMORY_CONTEXT_RUNTIME.md`
- `.agent/architecture/MEMORY_MAINTENANCE.md`
- `server/src/modules/memory/`
- `server/src/modules/runtimeContext/`
- `server/src/modules/proposals/`
- `server/src/modules/retrieval/`
- `server/src/db/schema/memory.ts`

## Related decisions

- [0003-memory-proposal-flow.md](../decisions/0003-memory-proposal-flow.md)
- [0014-unified-runtime-context-engine.md](../decisions/0014-unified-runtime-context-engine.md)

## Pending revision and frozen requests

Maintenance revision still requires the entry owner or Project writer and writes
only a Proposal. A linked frozen request makes revision return a fresh pending
Proposal id: the old draft/payload and request evidence remain, both superseded
in the same transaction. Audience, provenance and review gates carry forward;
no approval or operation receipt is copied. Unlinked drafts retain editing in
place. The browser opens the returned draft, and acceptance still uses the
canonical Memory applier; revision alone changes no active Memory.

## A person's own Memory as core commands (P5 continuation)

`memory/humanOperations.ts` registers six human-only commands behind the retained
URLs: `memory.propose_create` (POST `/memory`), `memory.propose_update` (PATCH),
`memory.archive` (DELETE), `memory.restore`, `memory.revert` and
`memory.proposal.revise`. They keep ADR 0003 / B10 exactly:

- Creating or changing what an entry says is always a proposal decided through
  the canonical applier. Placement is access-owned: a Project entry is
  `space_shared` in the Project's Space, otherwise a private `user` entry in the
  person's Personal Space. The transport refuses client attribution —
  `actor_user_id`, `provenance_entries`, owner, Agent, Room and visibility — and
  provenance is derived by the writer from the authenticated person.
- Archive, restore and undo of the person's **own** entry apply directly through
  the applier as new versions, with the entry row and chain locked by
  `authorizeOwnVersion` / `setOwnStatus`. Another person's or an ownerless entry
  is a `memory_archive` proposal (`outcome: proposed`).
- The domain's contextual `proposal.create` policy check (scope, visibility,
  sensitivity) still runs and its decision record joins the operation
  transaction, so a failed audit leaves no proposal or success receipt.
- Receipts carry ids only; the web re-reads the entry or proposal.

`memory.retrieval.feedback/reindex` share the retrieval factory with Knowledge;
feedback also records the owner's read statistic. Search, retrieval search/brief and create-safety now use the asynchronous request
commands below. Maintenance scan/jobs and consolidation remain retained REST
entries (Plan 5).


## Asynchronous retrieval requests (P5 continuation, partial block)

`memory.search.request`, `memory.retrieval.search.request`,
`memory.retrieval.brief.request`, and `memory.create_safety.request` retain their
four POST URLs as keyed human-only core adapters. A short admission transaction
stores only the existing Job queue intent and an identity/status receipt.
`content_retrieval_request` has `max_attempts = 1`; the existing dispatch/effect
claim fence runs providers outside transactions and refuses blind repetition
of an unknown outcome. Generic Jobs never return this Job's result.

The requester reads `/memory/retrieval/requests/:jobId`. The result reader pins
Memory roots, Project audiences, person/Space authority, grants and canonical
provenance into Source item/snapshot/Evidence/connection consent before canonical
adapter revalidation and privacy audit. A summary/denied contributing object
withholds the **whole** old result, including synthesis, provenance and diagnostic
fields. A new search produces a result for the current audience. Ordinary Memory
search rereads canonical active entries rather than releasing stored Memory rows;
its existing human-owner agent-scope read and sensitivity gates remain in force.
The web client submits once and polls only this reader in the receipt's Space.
These requests neither write active Memory nor change ADR 0003/B10.


## Report and consolidation request continuation

The maintenance scan, maintenance Job create/page run and consolidation retained
POST URLs now submit keyed, one-attempt content request Jobs. Their core receipt
contains identity/status only; `/memory/retrieval/requests/:jobId` rechecks current
Context Ops authority and every nested Memory/Activity/Artifact/Proposal reference
before releasing a result. Generic Jobs suppress report bodies. A page run uses
only its owner's Memory authority; shared Job readability is not impersonation.
The canonical maintenance services still persist private reports and pending
review packets. Consolidation retains short per-activity transactions and creates
pending proposals through the original provenance path. Both success and failure
writes retain active person, object read/owner and Job-claim fencing. No active
Memory content writer or ADR0003/B10 exception is introduced. Typed web clients
submit once and poll the receipt's Space. Reader12 remains outside this slice.

Persona revision admission checks the target version's canonical Run provenance
before loading its body for the Agent. The canonical direct and proposal appliers
repeat that check: a quarantined persona cannot become a deliverable version by
direct revision dropping old provenance. Direct versions retain their own write
rationale rather than copying prior provenance; proposal versions copy provenance.
Archive and a fresh permissible persona remain the existing recovery lifecycle.
