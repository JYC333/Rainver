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

### 2. The layer is invisible until a visibility decision has to be made

A Project with only its mainline shows conversations and never the word
"Room". Conversations of a limited Room appear in the same list, in a section
titled by its roster ("With Alice, Bob · 2 agents"). Creating a conversation
offers two things — in this Project, or with a limited group — and the second
is a roster picker whose completion creates the Room. The boundary is chosen
at the moment of creation and not asked about again, which is the same shape
as ADR 0013 decision 3: creation context determines the boundary, once.

The consequence accepted deliberately: for most Projects this layer is never
seen. An invisible correct layer is better than a visible wrong one, and the
alternative — a Rooms picker every user passes through to reach the only Room
they have — charges the common case for the rare one.

### 3. A limited Room is invisible to non-members, with no existence signal

Not a section, not a count, not "there is a conversation you are not part of".
Including to the Project owner and Space owners. This is the fail-closed 404
and no-existence-oracle rule of ADR 0013 applied one level down: a list that
says *something exists here* while a direct read says *it does not* is an
oracle, and "people are discussing something without me" is itself the
information the boundary exists to withhold. A member who wants others to know
says so in the mainline; the system does not say it for them.

One carve-out exists and is worth stating precisely, because a vague version
of it would be tested against and pass. A non-member with no oversight sees
nothing on any path: a Room's Runs are created `selected_users` with grants to
its members, so the content predicate excludes them. A Space owner or admin
under `oversight_mode` is different — the predicate's oversight disjunct
admits them without a grant, at `summary` under `oversight_mode = 'summary'`
and at **`full`** under `content` or `full`
([`SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)).
They never reach messages, which are gated on membership, and a Run's `prompt`
and `instruction` are nulled on every read regardless of who is asking.

Oversight is also narrower than "an admin sees everything", and the difference
decides whether a test of this is meaningful. The predicate ANDs a Project
scope conjunct (`projectReadAccessSql`) *outside* the disjunction oversight
sits in, and that conjunct has no oversight branch — so a Space owner who is
not a member of the Project is excluded from a Room's Runs whatever their
`oversight_mode`. The carve-out reaches only an admin already inside the
Project.

Run detail/list, Home work-product lists, and Project Pulse counts use the
same content predicate. Oversight tests must use an eligible admin who is
inside the Project; an admin outside it is excluded by Project scope and does
not exercise this exception. Room messages still require membership.

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

- The Room layer stays, and stays load-bearing, but its cost is paid only by
  the people who need it.
- Roster management remains a real surface, reached from the conversation list
  section it governs rather than from top-level navigation.
- Conversation reads and conversation-attention paths retain Room membership
  gates; Run/Proposal/Artifact reads retain their shared content predicate and
  the decision 3 oversight exception. Making the layer invisible in the interface must not
  make it invisible in the predicates — the two are opposite properties, and
  a section that renders "nothing" for a non-member is not the same as a query
  that returns nothing.
- Opening a Room to establish a channel now produces exactly that: a Room, and
  no conversation nobody wrote.

## Non-goals

- Room as a topic container, or a Rooms page as a navigation destination.
- Any existence signal about a limited Room or its conversations to a
  non-member, except the explicitly permitted oversight access to work-product
  metadata in decision 3. Oversight never admits Room messages.
- Preventing conversation creation while another conversation is empty.
- Changing how a Room executes a message (ADR 0007 decision 6).
- Merging the Room layer away.
