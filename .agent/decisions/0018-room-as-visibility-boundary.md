# ADR 0018: A Room Is A Visibility Boundary

Date: 2026-08-29

## Status

Accepted.

Current state of the implemented Room layer lives in
[`modules/rooms.md`](../modules/rooms.md); the Project side lives in
[`architecture/PROJECTS.md`](../architecture/PROJECTS.md). This document holds
the decision and its reasoning only.

Touches [ADR 0007](0007-multi-cli-mvp.md) decision 6 in vocabulary only: that
ADR describes how a Room *executes* — one run group per message, per-message
instructing human, governed resume — and nothing in it is superseded here.
This decision is about what opening a second Room *means*.

## Context

Conversations group a thread of discussion; Rooms define its audience. Treating
both as topic containers creates a redundant filing choice and leaves no clear
reason to open a second Room. Audience must be chosen once at the container
boundary, while execution choices are reviewed in an explicit Conversation
draft. A Project also needs a guaranteed mainline so callers do not depend on
which Room was created first.

## Decision

### 1. A Room is a visibility boundary

A Room means: **this set of people and agents can see these conversations.**
The only reason to open a second one is to exclude someone.

Consequences that follow directly:

- **Calling different agents in different situations is not a reason.** That
  is per-message recipient selection inside one Room
  (`recipient_segments` with `routing_mode: direct`), which already exists.
  A Room's roster answers *who may see*; a message's recipients answer *who is
  being asked*. Conflating them would make every change of collaborator a
  change of audience.
- **Grouping by topic is not a reason.** A conversation is already one thread;
  a second grouping layer above it would mean deciding, before speaking, which
  of two containers a thought belongs in.

Rejected alternatives:

- *Room as a topic container.* It competes with conversation for the same job
  and produces the pre-speech filing decision above.
- *Removing the layer, with per-conversation `selected_users` for privacy.*
  This pushes a heavyweight boundary into a lightweight action — the error
  [ADR 0013](0013-personal-team-content-boundary.md) decision 1 names for
  Spaces, in a smaller frame. Visibility should be a property of the container
  a conversation is created in, decided once, not a property re-chosen per
  thread.

### 2. Rooms are an explicit Project entry

Agents need a Project relation that is *not* a Room roster: an Agent can work
for a Project on its own, and adding it to the Project must not make it a
member of any Room or let it read a Room's history. With Agents and audiences
as separate relations, both have their own visible entry.

- The Project navigation has two parallel entries, **Agents** and **Rooms**.
  Agents is the Project's Agent list (`project_agent_links`, owned by the
  Projects module): a reference to an existing Agent, granting no Room
  membership, no Room history and no widening of a private Agent. Rooms is
  this decision's visibility boundary made visible.
- The Rooms index lists the Rooms the viewer is an active member of — the
  default (mainline) Room and their limited Rooms — each with its name, who
  can see it, and how many people and Agents are in it. Entering a Room shows
  its conversation list, with a Members view beside it; it never jumps into
  the newest conversation. A direct link to a conversation still opens it.
- A conversation names its Room and links back to that Room's list. Who can
  see it (the roster) and who is asked (the per-message recipients chosen in
  the composer) are shown as different things, as decision 1 requires.
- Adding an Agent from a Room completes its Project link in the same
  transaction; removing it from a Room keeps the link. Adding it to the
  Project joins no Room. A private Agent is still shared only with the exact
  current members of the Room its owner confirms, never with the Project.
- Creating a Room is a choice of audience made once, through one roster
  dialog whose completion creates the Room. The boundary is chosen at the
  moment of creation and not asked about again, which is the same shape as
  ADR 0013 decision 3: creation context determines the boundary, once.

A visible layer makes decision 3 easier to break, so it holds for every read
this entry adds. The Rooms index, the Project Agent list's "in these Rooms"
placements, and Room candidate lists all use the same active-membership join
as a direct Room read, so a limited Room the viewer is not in is absent — no
row, no count, no "in another Room" hint — including for Project owners and
Space owners/admins.

Rejected alternative: *a layer that stays invisible until a visibility
decision has to be made* (conversations only, limited Rooms as roster-titled
sections, no Rooms entry). The full Room page still had to show Rooms,
rosters and Room creation, so the product would describe one Room two ways,
and it leaves no visible home for the Project's Agent relation.

### 3. A limited Room is invisible to non-members, with no existence signal

Not a section, not a count, not "there is a conversation you are not part of".
Including to the Project owner and Space owners. This is the fail-closed 404
and no-existence-oracle rule of ADR 0013 applied one level down: a list that
says *something exists here* while a direct read says *it does not* is an
oracle, and "people are discussing something without me" is itself the
information the boundary exists to withhold. A member who wants others to know
says so in the mainline; the system does not say it for them.

Oversight is no carve-out, and this is worth stating precisely, because a
vague version of it would be tested against and pass. A Room's Runs are
created `selected_users` with grants to its members, and a Space owner or
admin under `oversight_mode` is admitted by the content predicate's oversight
disjunct
([`SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)).
That predicate is not sufficient on its own: a read of a Room-backed Run, or
of a Proposal or Artifact that a Run produced, also ANDs
`roomRunReadAccessSql`, which requires active Room membership plus Project
readability and has no oversight branch. A Space owner or admin inside the
Project but outside the Room is therefore excluded like any other non-member.
They never reach messages either, which are gated on membership, and a Run's
`prompt` and `instruction` are nulled on every read regardless of who is
asking.

Run detail/list, Home work-product lists, and Project Pulse counts carry both
terms. Tests of this boundary must use an admin who is inside the Project but
not on the Room roster; an admin outside the Project is excluded by Project
scope and does not exercise the Room term.

### 4. The mainline Room is created with the Project

On the same footing as the Brief v1 row every Project is created with
(PROJECTS.md, "Project Kernel"): a structural singleton, present from the
start, empty until used. One active mainline per Project is already a database
constraint; what was missing is that something guarantees it exists.

"A Project with no Room" therefore ceases to be a state. No caller handles its
absence, the chat panel's empty state is deleted, and a bug of the shape
"put this in the mainline — there isn't one" cannot recur.

**Assistant provisioning remains lazy, but Conversation setup is explicit.** A
Room is a channel; a channel nobody has opened does not need a manager Agent.
The explicit Conversation-draft action is the point at which the Project
manager may be provisioned and the execution preflight becomes visible. This
keeps Project/Room creation independent of backend configuration while still
letting the person review and confirm the Agent, Host, CLI, and workspace
before any message or Run is created.

### 5. Conversations are opened before speaking

Creating a Room creates no conversation. A visible, explicit draft action
opens the first Conversation and its execution preflight. The first message
is accepted only for an initialized Conversation, so it cannot implicitly
choose a Host, CLI, or workspace.

An empty draft is intentional and user-visible: it carries the execution
choices and can be abandoned without creating a message or Run. No background
event may replace its Host, CLI, or Primary Workspace. Continuing in another
Folder therefore means opening a new Conversation, while an existing draft or
initialized Conversation remains pinned to its own execution context.

## Consequences

- The Room layer stays, and stays load-bearing: a Project with only its
  mainline has one Room, and a second exists only when someone excludes
  someone.
- Roster management is a real surface: a Room's Members view, reached from the
  Rooms index, from the Room itself and from a limited group's section in the
  cross-Room conversation list (decision 2).
- Conversation reads and conversation-attention paths retain Room membership
  gates; Run/Proposal/Artifact reads AND their shared content predicate with
  Room membership, so oversight admits no Room work product. Hiding a limited
  Room in the interface must not be its only protection — the predicates must
  exclude it too, and a section that renders "nothing" for a non-member is
  not the same as a query that returns nothing.
- Opening a Room to establish a channel now produces exactly that: a Room, and
  no conversation nobody wrote.

## Non-goals

- Room as a topic container, or a cross-Project Rooms index (the Rooms entry
  is per Project, decision 2).
- Any existence signal about a limited Room or its conversations to a
  non-member. Oversight never admits Room messages or Room work products.
- Preventing conversation creation while another conversation is empty.
- Changing how a Room executes a message (ADR 0007 decision 6).
- Merging the Room layer away.
