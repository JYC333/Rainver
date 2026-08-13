# ADR 0013: Personal And Team Content Boundary

Date: 2026-08-06

## Status

Accepted - 2026-08-06

Amends [ADR 0001](0001-space-model.md) (cross-Space read; the invariant and its
five constraints live in that ADR's Amended section). Builds on the canonical
content access model; nothing is superseded.

## Context

Enforcement is already correct: one canonical read predicate, a resource
registry derived from the ontology, fail-closed 404s, immutable oversight
modes, four audited cross-Space exceptions. What was missing is **defaults,
derivation, and attribution** — privacy properties that hold at the point of
enforcement and are dropped at the point of creation or derivation. Three
defects of exactly that shape were found in code, and visibility column
defaults split 7/6 across tables with no rule explaining which is which.

**Threat model: accidental disclosure.** A teammate who wrote something
believing it was theirs — not a malicious admin, not an external attacker.
Decisions that would only harden against a deliberate insider are out of scope.

## Decisions

### Attribution

1. **Personal Space and team `private` are asymmetric.** The personal Space is
   the sole landing point for context-free capture; team-Space `private` is an
   exception state (demoted, withdrawn, or oversight-derived content), not a
   daily write target. A Space is a heavyweight boundary and must never be a
   choice made during a lightweight action.
2. **The sticky write target is removed.** A remembered destination that is
   invisible at the moment of writing is a mode error, not a convenience.
3. **Creation context determines Space, scope, and visibility together.**
   Inside a Project → that Project's Space, that Project, `space_shared`. No
   project context → personal Space, no scope, `private`. Resource type does
   not enter into it. The user expresses sharing intent once, by choosing where
   to act.
   - **3a. Annotations are personal marginalia.** An annotation takes its
     document's Project scope but defaults to `private` even on a shared
     document; sharing is opt-in and can never exceed the document's own
     visibility. Decision 3 alone would publish a margin note the moment it is
     typed, which is the failure this ADR exists to prevent.
4. **The product exposes one ladder** — only me → in this project → whole Space
   — over the unchanged two-axis mechanism. `selected_users` is an explicit
   per-person share outside the ladder.
5. **There is no draft state inside a Project.** Putting something into a
   Project *is* the act of sharing it. Lifecycle state stays where a domain
   genuinely needs it and is never overloaded onto visibility.
6. **Filing a capture into a Project is a transformation, not a copy.** A new
   object is created in the target Space; the capture stays in the personal
   Space as provenance. There is no second copy, therefore no synchronisation
   problem. Both directions are writes: capture ownership and target-Project
   writer authority are both checked.

### Cross-Space reading

7. **The personal assistant retrieves across the user's Spaces**, each applying
   its own predicate. See the ADR 0001 amendment for the invariant and
   constraints.
8. **Results persist as pointers only.** Content is re-resolved on next use, so
   membership revocation takes effect with no cascade delete.
9. **Single-source summaries are written back to their source Space**,
   owner-private. This is capability accumulation, and it makes access control
   automatic: lose membership, lose the summary.
10. **Fused conclusions are never persisted automatically.** A conclusion
    drawing on two or more Spaces cannot be attributed, and pointers do not
    help — a conclusion is new information, not a composition of references. A
    user *may* store one explicitly, with lineage and an egress record on each
    source Space. The principle is *do not automate it, and leave a trace*.
11. **Egress notification is a mutable, broadcast Space setting**, defaulting on
    for `team`. Unlike `oversight_mode` it may change, because it governs
    per-action records rather than a standing read capability; changes broadcast
    to all members and apply forward only. Two constraints are non-negotiable,
    or the notification becomes a leak channel itself: **pointer metadata only,
    never conclusion text**, and **disclosed before the action**.
12. **Space membership stays the outer gate.** Direct reads of a resource id
    outside the request Space still 404 with no existence oracle.

### Derivation

13. **Taint propagates to defaults, not as a hard ceiling.** A derived output
    defaults to the narrowest visibility among its inputs; the owner may then
    publish. A hard ceiling would leave a team agent unable to produce team
    output after touching any personal content.
14. **Taint owned by someone else narrows to the intersection.** Output
    defaults to the instructing user plus the content owner, and publishing
    beyond that requires the **content owner's** approval, reusing the existing
    egress approval shape. Oversight already flows into retrieval and per-run
    context; this bounds the consequence.
15. **Taint is computed at Run granularity from snapshot columns**, written at
    snapshot time. Model self-reporting is rejected as a basis: a privacy
    boundary must not rest on the model's account of what it used. Run
    granularity is conservative, and that is accepted.
16. **Agent is not an attribution axis for memory.** `agent_id` is provenance.
    Content is personal (about a person), project (about how the work is done),
    or capability (about how the agent works); real team-shared memory is the
    project layer, which already exists and is already ACL-gated. Landing
    follows decision 3, with decision 13 taking precedence.

### After the fact

17. **Demotion applies forward only and discloses the exposure honestly** —
    readers, consuming Runs, still-shared derived outputs. Letting a user
    believe they retracted something is itself a privacy harm.
18. **Read auditing covers cross-person reads only** (`viewer <> owner`). That
    is exactly the set privacy cares about, and it keeps write amplification off
    the common path. Coverage must include ordinary detail reads, not only
    retrieval paths, or decision 17's disclosure under-reports.
19. **Project Folders get a boundary declaration, not file-level ACLs.** A
    Project Folder is a shared workspace with no personal area. The filesystem
    is externally mutable, so a file-level ACL would drift from reality on the
    first `git checkout` and become a second, weaker source of truth.

## Amended - 2026-08-11 (capture destinations)

Merging the two competing capture entries forced the literal reading of
decisions 3 and 5 to be settled, because taken at face value they say a thought
typed inside a Project is published to the team on the keystroke. The
amendment is recorded here rather than in a superseding ADR: two authorities on
the same boundary is the failure this document exists to prevent.

**3b. Ownership and pipeline are separate axes.** Decision 3 binds Space, scope
and visibility to creation context, and that stands. It does *not* also bind
the processing pipeline. Capture inside a Project therefore has four
destinations, not one:

| Destination | Scope | Visibility | Pipeline |
|---|---|---|---|
| Marginalia on the Area's current object | the Project | `private` | written straight into a note |
| Project marginalia | the Project | `private` | written straight into a note |
| Project raw material | the Project | `space_shared` | stays `raw`, awaiting processing |
| Personal inbox | none | `private` | stays `raw`, awaiting processing |

The failure this prevents is the mirror of the one the ADR was written for.
Binding the axes together — Project implies shared, personal implies reviewed —
leaves external material pasted into a Project with no correct destination: it
becomes the user's private marginalia, invisible to the team it was meant for.
Not accidental disclosure, but accidental concealment, and equally silent.

**3c. Hand-typed capture inside a Project is decision 3a marginalia.** A thought
captured against a Thread — "the control group here is wrong" — is marginalia in
form, so it takes the Project's scope and defaults to `private`. Because
`space_objects.visibility` is row-level, a note cannot mix private and shared
paragraphs; marginalia therefore lands in a **separate per-user, per-target
private note**. The model does not fork for single-member Spaces — only the UI
omits the "team / mine" wording there, so a personal-Space Project that later
gains members needs no migration.

**Decision 5 is unchanged and still binding.** There is no draft state inside a
Project. Marginalia is not a draft of team content; it is a different kind of
object with its own visibility, and promoting it to team material is an
explicit relocation rather than a state change.

**Decision 2 is load-bearing here.** The destination default is inferred from a
deterministic signal — a paste event or a URL — and is *never* remembered from
the previous capture. A remembered destination is invisible at the moment of
writing, which is the mode error decision 2 removed once already.

## Amended - 2026-08-12 (relocation, the outward direction)

Decision 6 legislates personal → Project and nothing legislates the reverse, so
until now content that landed in a Project could not leave it. That gap was not
neutral: capture ships **inferred** destination defaults, one of which sends a
paste to the Project's team-visible raw material, and the whole case for
inferring rather than asking is that a wrong inference can be undone. Without an
outward path the inference is one-way and a misfiling has no remedy. Recorded
here rather than in a new ADR for the same reason as the previous amendment.

**6a. Move and copy are different acts with different authority.**

*Move* is decision 6's transformation run backwards: the original leaves the
Project. It requires authority over the **content** — its `owner_user_id`, the
Project's owner, or a Space owner/admin. Being able to contribute to a Project
is explicitly not authority to remove what a colleague contributed, so ordinary
Project membership is not enough.

*Copy* leaves the original in place. It is not a loss to the team but it is
egress — a second holder outside the Space's boundary.

The two are kept apart because their consequences differ: a move changes what
the team has, a copy changes who else holds it.

**6b. The Space setting governs other people's content, not your own.**
`spaces.member_copy_out_enabled` is **default off** and changed by an owner or
admin. It gates taking *another member's* content out of the Space, by either
verb.

Your own content is never gated by it. Taking a misfiled thought back out is the
remedy that makes capture's inferred defaults defensible at all — a paste
defaults to the Project's team-visible raw material, and a guess that cannot be
undone should not have been made. A setting that is off by default would remove
exactly the capability the outward direction exists for.

**What counts as leaving is where the row lands, not what the destination is
called.** Every Project destination resolves its Space from the caller's
`project_id` and the request Space header, both client-supplied, so a
destination named `project_marginalia` can cross a boundary. The gate resolves
the destination Space first and compares it with the source. Testing the
destination *label* would enforce B4 for one name and leave the others open.

Authority for a move is checked on the source side and is project-scoped: a
capture with no Project — every `personal_inbox` capture — is movable by its
owner alone, because there is no Project for anyone to administer.

A copy out is announced under decision 11, with its two non-negotiables intact:
**pointer metadata only, never the content**, and disclosed in the composer
before the action rather than reported after it.

**What relocation carries is the user's decision.** The note's current text is
authority, never the capture's `activity_record` snapshot — treating the
snapshot as authority would silently discard every edit made after capturing.
And block adhesion has no automatic rule: the anchored block is preselected, the
blocks after it up to the next capture or heading are offered unchecked, and the
author chooses. Absorbing too few tears a thought in half; too many drags a
colleague's paragraph along. Both damage data, and only the author knows.

## Consequences

- Users make zero privacy decisions during capture *by default*: the
  destination and its consequence are shown before typing and the default is
  inferred, but choosing another destination is one click (amendment 3b). The
  cost is that writing to a team still requires a project entry point or one
  explicit filing action.
- Personal Spaces become high-traffic. Their capture inbox has to be good, or
  users will route around it — the failure this ADR exists to prevent.
- The strongest isolation boundary now has a controlled opening. Every
  cross-Space read path must be enumerated and individually justified.
- Derived outputs default narrower than before; some team output needs one
  explicit publish it did not need previously. That is the intended trade.
- The read audit log becomes a privacy-relevant asset of its own; it is
  readable by the resource owner only.

## Non-goals

- Defending against a deliberate insider with legitimate access.
- File-level access control inside Project Folders (decision 19).
- Attributing fused cross-Space conclusions (decision 10 — the system declines
  rather than guesses).

## Deferred

Tracked with their triggers in
[deferred-register.md](../tasks/deferred-register.md):

- Ownership of orphaned `private` rows after a member leaves a Space.
- Explicit consent to a Space's `oversight_mode` when joining an existing Space.
- Detail-read auditing for the registered types beyond Task, Activity,
  Artifact, and note/`space_object`.

## Current state

Implementation detail belongs to the architecture docs, not here:
[`SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
(content access, taint, aggregated read),
[`SHARED_SPACE_MEMORY_ISOLATION.md`](../architecture/SHARED_SPACE_MEMORY_ISOLATION.md)
(memory layers), and
[`DATABASE_AND_TRANSACTIONS.md`](../architecture/DATABASE_AND_TRANSACTIONS.md)
(column defaults as storage backstops).
