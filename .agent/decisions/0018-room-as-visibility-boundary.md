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

Rooms shipped with rosters, a manager agent, per-message recipient selection,
and a membership join on every read. What the product surfaces of that is not
the boundary but a filing metaphor: the conversation list has a **"Topic
Rooms"** heading and a **"New topic Room"** button, `/projects/:id/rooms` is
described as the Project's primary workspace, and the top navigation has a
Rooms entry — while the chat panel silently binds to whichever Room happened
to be created first. The word the interface teaches is "topic", which is the
one meaning a Room does not have.

Three symptoms of the same gap surfaced together.

**Nobody could say when to open a second Room.** Asked why one might, the
honest answers available were "different agents get involved" and "a different
topic" — but the first is already served by per-message `recipient_segments`
inside one Room, and the second competes with conversation, which is already
"one thread". Neither answer distinguishes a Room from something the system
already has.

**A Project could exist with no Room at all.** The mainline is not created
with the Project; the first Room created becomes it. The chat panel therefore
carries an empty state ("This Project has no conversation yet") whose button
creates a *Room*, and every other caller wanting to put something in the
mainline has to handle its absence. Ambient CLI session import found this the
hard way: "Continue in Rainver" on a freshly bound Project — the feature's own
typical path — failed with "This Project has no mainline Room".

**Opening a Room creates an empty conversation.** A Project that has been
spoken to once has one Room and one conversation; a Project that has not has
neither; and a Room opened to establish the channel — rather than to say
something — carries a "New conversation" nobody wrote.

The layer was three deep in the data and two deep in the product, and the
missing middle was where the meaning should have been.

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

When this was written the two Run paths disagreed for exactly that person:
`getVisibleRun` carried a room-membership join and 404'd, while `listRuns`
carried only the content predicate and listed the Runs the detail page denied.
They now share one predicate, and so do the Home Run, Proposal and Artifact
lists and the Project Pulse counts — a list must not show what its detail page
then 404s on. Oversight reaching Run metadata is intended; reaching it from one
surface and not another was not.

The trap that statement sets, worth keeping: a test written with a Space owner
*outside* the Project passes without touching the behaviour at issue, because
the Project scope conjunct already excludes them. The subject has to be an
oversight-eligible admin who is a member of the Project.

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
- Every read path that lists conversations, Runs, or attention items must keep
  its membership join. Making the layer invisible in the interface must not
  make it invisible in the predicates — the two are opposite properties, and
  a section that renders "nothing" for a non-member is not the same as a query
  that returns nothing.
- Opening a Room to establish a channel now produces exactly that: a Room, and
  no conversation nobody wrote.

## Non-goals

- Room as a topic container, or a Rooms page as a navigation destination.
- Any existence signal about a limited Room to a non-member.
- Preventing conversation creation while another conversation is empty.
- Changing how a Room executes a message (ADR 0007 decision 6).
- Merging the Room layer away.

## Revision history

- **2026-08-29** — proposed and accepted the same day.
- **2026-08-29** — implemented: the Room boundary work (mainline created with
  the Project, conversations created through an explicit draft/setup action, the Room layer invisible
  until a visibility decision is made) and, on top of it, thread references —
  content copied once between threads with a server-enforced disclosure
  confirmation. Current state: [`modules/rooms.md`](../modules/rooms.md).
