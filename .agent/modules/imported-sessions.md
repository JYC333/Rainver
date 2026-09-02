# Module: Imported Sessions

Ambient CLI history: the sessions a person had with their own Claude Code,
Codex, or OpenCode inside a folder, outside Rainver, on a machine they paired
as an execution host ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)).
This module brings that history into the Project the folder is bound to, and
turns what it holds into proposals.

The rollout plan (`ambient-session-import-plan.md`, both phases shipped
2026-08-28 in `293023c3`, `d162aabf` and `178bd9a8`) is retired; its execution
ledger is in git history and its two open leftovers are in
[`plans/backlog.md`](../plans/backlog.md) §9. **This document describes the
system as it stands.**

## Why it exists

Someone who has already worked in a folder with their own CLI has a month of
context Rainver cannot see. Without it, the first Run dispatched to that folder
starts from nothing, and the reasoning behind decisions already made is
unrecoverable. The import is how that stops being true.

It is deliberately *not* a way to continue a vendor conversation. A vendor
session is never resumed, never treated as an authority, and never read as
state ([ADR 0004](../decisions/0004-context-wrapper.md),
[ADR 0014](../decisions/0014-unified-runtime-context-engine.md) decision 11).
What is imported becomes Rainver's own records.

## Where the history comes from

Every supported runtime exposes its past sessions through the Agent Client
Protocol — `session/list` to enumerate for a directory, `session/load` to
replay one as `session/update` notifications. That is the only source. There is
no vendor session-file parser anywhere in the tree, and adding one is a
non-goal: the formats are undocumented, self-corrupting (chains that break on
resume, one conversation split across files by compaction), and there would be
three of them to maintain forever.

A runtime that does not advertise both `list` and `load` is not offered.

The daemon runs the ACP conversation and returns trimmed, redacted records; the
server never sees the raw replay. That division exists because both trimming
and redaction must happen before anything crosses the network:

| Update kind | Kept |
|---|---|
| user text | in full — intent is what a later reader needs |
| agent text | in full — decisions and their explanations live here |
| `tool_call` | name, status, and truncated arguments — what files, what commands |
| `tool_call_update` | status and the first 512 bytes of the result |
| `plan` | the last version only |
| `agent_thought_chunk` | dropped |
| `usage_update` | forwarded to the usage ledger, not stored as a record |

Measured on a real machine: conversation text is 2.6–4.5 % of a session's
on-disk bytes and tool output is 13–41 %. Trimming output is what makes import
viable at all, and it is also where a printed key would be.

Daemon-side modules: `ambientSessions.ts` (ACP client, enumeration, replay),
`ambientRecords.ts` (updates → records), `ambientRedaction.ts` (secret patterns
and byte budgets), `ambientCounts.ts` (the slow-refresh counts a heartbeat
reports).

## Sync is a set reconciliation, not a cursor

An ambient source is rewritten when a session resumes, split when it is
compacted, and forked when it is rewound. Any "everything after position N"
bookmark is wrong the first time someone uses their own CLI normally.

- **Identity** is `(host, installation, vendor session id, message or tool-call
  id)` plus a content hash. The session id is in the key because Codex numbers
  its message ids `item-1`, `item-2` … per session.
- **The incremental unit is the session.** Replaying costs an agent process, and
  `session/list` reports every session's `updatedAt` in one call, so the server
  sends the timestamps it holds and the daemon replays only what moved.
- **Reconciliation is record-level and server-side.** Seen and identical is
  skipped; unseen is inserted; seen with a different hash is *not* overwritten —
  the first import stays authoritative and `conflict_hash` records that the
  source disagreed, because by then the import may be the only copy.
- **Gone is decided by what the host enumerated**, never by what the server
  holds. `held` (everything the runtime still has for the folder, before any
  window or cap) is kept separate from `selected` (what this sync will replay),
  and an enumeration that returned rows of which none matched the folder is
  reported inconclusive rather than as evidence the folder is empty.
- **Nothing is mirrored.** A vanished source sets `source_state = 'gone'`;
  unbinding a Location, unregistering a Folder, or unpairing a host sets the
  owning columns null and deletes nothing. Re-binding the same folder re-adopts
  the orphaned rows instead of importing a second copy.

## Consent

Binding a folder only counts what the machine holds. Importing is a separate
act, because a person's own terminal history becoming Project content is a
decision.

- The offer is made once, as a banner on the Project page, and answering it
  either way stops it being asked again.
- **The visibility picker is the only gate**, and it states the consequence at
  the point of choice: *Project shared* is readable by members and is what
  extraction reads; *only me* is a read-only archive that extraction never
  touches. There is deliberately no second confirmation later, which is why the
  choice is persisted to the Location's policy rather than held in the page —
  a background sync reads the stored default.
- **Standing consent per (Location, runtime)** is what lets a later heartbeat
  import new conversations. Without it an import happens once. It is revocable,
  and revoking stops future syncs without deleting anything.
- Only the host's registered owner may import, change policy, or delete
  ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)'s hard rule).
  Reading goes through the canonical content predicate instead: a shared session
  is ordinary Project content, a private one stays with its owner, and a
  transcript requires `full` access — `summary`, which oversight grants an admin
  over a colleague's private content, does not open one.

## Storage

`imported_sessions` is an independent root Entity
([ADR 0012](../decisions/0012-ontology-ownership-and-language-alignment.md)
decision 6), registered as a content resource so the one read gate filters it,
and not a `space_objects` row: it takes part in no cross-domain semantic
relation and is only ever cited as provenance.

`imported_session_records` holds the trimmed records. `extracted_in` carries
`claim:<id>` while an extraction holds a batch and the bare id once its
proposals exist — the two are distinguishable so a batch left behind by a
process that died can be swept back, which the pending count does before
reporting, because that count is what decides whether the button that would
have swept it is shown at all.

`imported_history_summaries` holds one short account per session — what a
whole-session reference carries, since a thousand-record transcript has no
other bounded form. Deliberately not the Room's summary machinery: that
service compacts a *growing* message thread, carrying a covered-through
message and a supersession chain, and an imported session has neither. Its
records are fixed until the folder is re-synced, so one row is enough,
rewritten when `last_record_at` moves past `covered_through_record_at`. The
upsert is monotonic, because two runs may overlap and the slower one read the
older records.

One is produced **on demand**: when somebody references a whole session and no
current summary exists, in the attach path but outside the Room row-lock
transaction. Nothing is generated at import, and that is deliberate. A first
sync can land two hundred sessions; describing every one of them to serve the
few anyone reaches for is waste, and on a *scheduled* sync it is also spending
nobody was present to authorize
([ADR 0010](../decisions/0010-agent-workbench-product-direction.md)). The
person's own press of "Continue in Rainver" is both the consent and the bound.

Generating it therefore needs the same access gate the copy does — `full`,
`includeOversight: false`, under the asking person's identity — because the
call is metered to the session's *owner*. Without that gate a session id alone
would let anyone spend a colleague's budget, and the timing would tell them
whether the session exists.

Each sync writes one `ActivityRecord` pointer (B24A: the Inbox holds pointers,
never content) and forwards any reported token usage to the canonical ledger
under `source_type = ambient_host_history`, attributed to the host owner and
keyed by content so a re-sync cannot count it twice.

## Extraction

Reads a batch of unextracted records from **shared** sessions only — the Brief
has no per-object visibility, so a private session's content would reach every
Project member through it — and produces proposals, never writes
([ADR 0003](../decisions/0003-memory-proposal-flow.md)):

- a **Project Brief draft** carrying decisions and constraints, cited back to
  the records they came from through the Brief's `source_refs`. Decisions are
  strings because that is what `confirmed_decisions` is everywhere. A Project
  with no goal gets one proposed from what was read, cited; a placeholder would
  be worse than none, since the next Run reads the goal as the Project's
  purpose. When neither a goal nor a Brief can be formed, what was found goes
  into the packet below rather than being discarded.
- a **memory packet** whose acceptance creates one `memory_create` proposal per
  candidate, in the project layer. One packet rather than a dozen proposals,
  because a Project's attention list has to stay short enough to read
  ([ADR 0011](../decisions/0011-inquiry-domain-model.md) decision 6).

No Tasks are generated: a "next step" from finished history is usually already
done, and a list of them is work for the reader rather than for the Project.

The contract is the Runtime Context semantic checkpoint's — the same system
prompt, exported so there is one definition of it, and the same strict output
schema. What is not reused is that extractor's metering, which resolves a Work
Context Setup; imported history has no work context scope, and inventing one to
satisfy a lookup would be contorting the mechanism rather than reusing it.

A batch is claimed atomically before the model is called, so a scheduled
extraction and a pressed button take disjoint work instead of both paying for
the same records. A second extraction merges into a Brief proposal already
waiting rather than opening a second one — each proposal carries a complete
replacement for the decision list, so two pending ones would silently drop each
other's work, including across two people extracting into one Project.

Extraction runs unasked only where the person turned that switch on. A first
import extracts once, because someone who has just imported a folder and been
shown raw records has been given nothing to act on; a scheduled sync is nobody
being present, and attended consent does not stand in for unattended spending
([ADR 0010](../decisions/0010-agent-workbench-product-direction.md)).

## Surfaces

- **Folder settings** — the per-runtime import policy: counts, the visibility
  picker, "keep syncing", "extract automatically" (default off), "import now",
  and batch delete. Deleting warns first: the host's copy may already be gone,
  so this can be the only one, and anything already extracted keeps its text
  while its citations stop resolving.
- **Project conversations** — imported sessions listed read-only beside the
  Project's own, marked as such on the row rather than only on the page they
  open, plus "Extract to Brief" when there is something unread.
- **An imported session** — a deterministic derived view (files touched,
  commands run) above the transcript, and a continuation that hands the Room's
  own composer a **reference** to the session rather than dispatching from a
  second path beside it.

  Where it lands follows the session's own audience, and the test is that
  everyone in the destination can already read *all* of it — `space_shared` at
  `full` access continues in the Project's mainline. Everything else continues
  in the person's **personal Room** in that Project — a Room whose audience is
  them alone, opened the first time it is needed and reused after
  ([ADR 0018](../decisions/0018-room-as-visibility-boundary.md)). That covers
  a private session, and equally `selected_users` or a `summary`-level share:
  both name a narrower audience than the Project's readers, so landing them in
  the mainline would be a disclosure the server refuses without a confirmation
  the UI cannot yet show. The button is no longer withheld from a private
  session, because the destination now protects it by construction — which is
  what withholding it was protecting.

  What is held for the composer is the reference, keyed by Room and the
  explicitly opened Conversation draft, not seed text. The reference is
  attached through the Conversation endpoint before the addressed message.
  Abandoning the draft leaves no message or Run behind.

  An imported session's records can also be **referenced** into a conversation:
  picked at the source and copied in as a `reference` message, once, with
  provenance and `external_untrusted` trust
  ([`rooms.md`](rooms.md) §Thread References).
  A *whole* session can be too: that grain carries the session's
  `imported_history_summaries` row, written on demand if it has none. The 409
  naming the records as the alternative is now reserved for a session that
  cannot be summarized at all — no readable records — rather than one whose
  turn has not come. Either way it is refused rather than silently shipping a
  truncated transcript under the name "the session".

  The read is `readImportedSessionForViewer`, the module's own, so the
  transcript gate has one definition. Two things about it. It requires `full`,
  not merely "not denied", because the gate also grants `summary` and a
  transcript is the content itself. And the reference path passes
  `includeOversight: false`: `full` alone does *not* exclude oversight — an
  admin in a Space with `oversight_mode` of `content` or `full` reaches it on a
  colleague's private session — which is right for a person opening the page
  and wrong for a caller that copies the transcript where other people read
  it. Oversight is audit, not a route to publish.

  The live explicit-reference wiring that briefly existed — resolver,
  context-authority read, delivery re-authorization — is gone. It re-resolved
  a pointer every turn, which is the shape a reference deliberately is not.

  Carrying a session into a thread is what a thread reference is for; a
  per-conversation Work Context Setup, which would pin one, stays on the
  backlog as R1.5 — a Room conversation's scope is `(Room, agent)`, so pinning
  there would reach every conversation that person has with that agent in that
  Room.

Server-host Locations show none of this: server-side CLIs run under managed
profiles and have no ambient history.
