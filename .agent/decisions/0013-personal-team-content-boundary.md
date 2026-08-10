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

## Consequences

- Users make zero privacy decisions during capture. The cost is that writing to
  a team requires a project entry point or one explicit filing action.
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
[hardening-blind-spot-remediation-plan.md](../plans/hardening-blind-spot-remediation-plan.md):

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
