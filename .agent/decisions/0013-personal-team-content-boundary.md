# ADR 0013: Personal And Team Content Boundary

Date: 2026-08-06

## Status

Accepted. Amends [ADR 0001](0001-space-model.md) decision 3 (the per-user
aggregated cross-Space read and its five constraints live there). Builds on
the canonical content access model; nothing is superseded. Implementation
detail lives in
[`architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md)
(content access, taint, aggregated read),
[`architecture/SHARED_SPACE_MEMORY_ISOLATION.md`](../architecture/SHARED_SPACE_MEMORY_ISOLATION.md)
(memory layers), and
[`architecture/DATABASE_AND_TRANSACTIONS.md`](../architecture/DATABASE_AND_TRANSACTIONS.md)
(column defaults as storage backstops).

## Context

Enforcement was already correct: one canonical read predicate, a resource
registry derived from the ontology, fail-closed 404s, immutable oversight
modes, four audited cross-Space exceptions. What was missing is **defaults,
derivation, and attribution** — privacy properties that hold at the point of
enforcement and are dropped at the point of creation or derivation. Three
defects of exactly that shape were found in code, and visibility column
defaults split 7/6 across tables with no rule explaining which is which.

**Threat model: accidental disclosure** — and, symmetrically, accidental
concealment. A teammate who wrote something believing it was theirs, or
pasted something for the team that landed where only they can see it. Not a
malicious admin, not an external attacker; decisions that would only harden
against a deliberate insider are out of scope.

## Decisions

### Attribution

1. **Personal Space and team `private` are asymmetric.** The personal Space
   is the sole landing point for context-free capture; team-Space `private`
   is an exception state (demoted, withdrawn, oversight-derived, or
   marginalia), not a daily write target. A Space is a heavyweight boundary
   and must never be a choice made during a lightweight action.
2. **No sticky write target.** A remembered destination that is invisible at
   the moment of writing is a mode error, not a convenience. Destination
   defaults are inferred from a deterministic signal of the current act — a
   paste event, a URL, the Area being viewed — never from the previous
   capture.
3. **Creation context determines Space, scope, and visibility together.**
   For shared work inside a Project → that Project's Space, that Project,
   `space_shared`; marginalia follows decisions 4–5 and limited conversations
   follow [ADR 0018](0018-room-as-visibility-boundary.md). No
   Project context → personal Space, no scope, `private`. Resource type does
   not enter into it; the user expresses sharing intent once, by choosing
   where to act.
4. **Ownership and pipeline are separate axes.** Decision 3 binds Space,
   scope, and visibility to creation context; it does *not* bind the
   processing pipeline. Capture inside a Project therefore has four
   destinations:

   | Destination | Scope | Visibility | Pipeline |
   |---|---|---|---|
   | Marginalia on the Area's current object | the Project | `private` | written straight into a note |
   | Project marginalia | the Project | `private` | written straight into a note |
   | Project raw material | the Project | `space_shared` | stays `raw`, awaiting processing |
   | Personal inbox | none | `private` | stays `raw`, awaiting processing |

   Binding the axes together — Project implies shared, personal implies
   reviewed — leaves external material pasted into a Project with no correct
   destination: it becomes the user's private marginalia, invisible to the
   team it was meant for.
5. **Annotations and hand-typed capture inside a Project are marginalia.** An
   annotation takes its document's Project scope but defaults to `private`
   even on a shared document; sharing is opt-in and never exceeds the
   document's own visibility. A thought captured against a Thread ("the
   control group here is wrong") is marginalia in form and lands the same
   way. Because `space_objects.visibility` is row-level, a note cannot mix
   private and shared paragraphs, so marginalia lands in a **separate
   per-user, per-target private note**. The model does not fork for
   single-member Spaces — only the UI omits the "team / mine" wording — so a
   personal-Space Project that later gains members needs no migration.
6. **One ladder** — only me → in this project → whole Space — over the
   unchanged two-axis mechanism. `selected_users` is an explicit per-person
   share outside the ladder.
7. **A draft lifecycle is not a privacy boundary for Project content.**
   Filing shared work into a Project shares it. This does not prohibit the
   explicit Conversation setup draft required by ADR 0018, which initializes
   execution and creates no message or Run. Marginalia is not a draft of team content; it is a different
   kind of object with its own visibility, and promoting it is an explicit
   relocation, not a state change. Lifecycle state stays where a domain
   genuinely needs it and is never overloaded onto visibility.
8. **Filing personal capture into a Project is a transformation, not a
   copy.** A new object is created in the target Space; the capture stays in
   the personal Space as provenance. No second copy, so no synchronisation
   problem. Both capture ownership and target-Project writer authority are
   checked.
9. **Leaving a Project: move and copy are different acts with different
   authority.** *Move* is decision 8 run backwards — the original leaves the
   Project — and requires authority over the **content**: its
   `owner_user_id`, the Project's owner, or a Space owner/admin. Being able to
   contribute to a Project is not authority to remove what a colleague
   contributed. *Copy* leaves the original in place; it is not a loss to the
   team but it is egress — a second holder outside the boundary.
   `spaces.member_copy_out_enabled` (default off, owner/admin-changed) gates
   taking *another member's* content out by either verb; **your own content
   is never gated by it**, because taking a misfiled thought back out is the
   remedy that makes decision 2's inferred defaults defensible at all.

   What counts as leaving is where the row lands, not what the destination is
   called: every Project destination resolves its Space from client-supplied
   `project_id` and Space header, so the gate resolves the destination Space
   first and compares it with the source. Authority is checked on the source
   side; a capture with no Project is movable by its owner alone. What
   relocation carries is the note's current text — never the capture's
   `activity_record` snapshot — and block adhesion has no automatic rule: the
   anchored block is preselected, following blocks up to the next capture or
   heading are offered unchecked, and the author chooses.

### Cross-Space reading

10. **The personal assistant retrieves across the user's Spaces**, each
    applying its own predicate (ADR 0001 decision 3).
11. **Results persist as pointers only.** Content is re-resolved on next use,
    so membership revocation takes effect with no cascade delete.
12. **Single-source summaries are written back to their source Space**,
    owner-private. Lose membership, lose the summary.
13. **Fused conclusions are never persisted automatically.** A conclusion
    drawing on two or more Spaces cannot be attributed; a user *may* store one
    explicitly, with lineage and an egress record on each source Space.
14. **Egress notification is a mutable, broadcast Space setting**, default
    on for `team`. Unlike `oversight_mode` it may change, because it governs
    per-action records rather than a standing read capability; changes
    broadcast to all members and apply forward only. Two constraints are
    non-negotiable, or the notification becomes a leak channel: **pointer
    metadata only, never content or conclusion text**, and **disclosed in
    the composer before the action**, not reported after. A copy out under
    decision 9 is announced the same way.
15. **Space membership stays the outer gate.** Direct reads of a resource id
    outside the request Space still 404 with no existence oracle.

### Derivation

16. **Taint propagates to defaults, not as a hard ceiling.** A derived output
    defaults to the narrowest visibility among its inputs; the owner may then
    publish. A hard ceiling would leave a team agent unable to produce team
    output after touching any personal content.
17. **Taint owned by someone else narrows to the intersection.** Output
    defaults to the instructing user plus the content owner; publishing
    beyond that requires the **content owner's** approval, reusing the egress
    approval shape.
18. **Taint is computed at Run granularity from snapshot columns**, written
    at snapshot time. Model self-reporting is rejected as a basis. Run
    granularity is conservative, and that is accepted.
19. **Agent is not an attribution axis for memory.** `agent_id` is
    provenance. Content is personal, project, or capability; real
    team-shared memory is the project layer, which is already ACL-gated.

### After the fact

20. **Demotion applies forward only and discloses the exposure honestly** —
    readers, consuming Runs, still-shared derived outputs.
21. **Read auditing covers cross-person reads only** (`viewer <> owner`),
    including ordinary detail reads, not only retrieval paths.
22. **Project Folders get a boundary declaration, not file-level ACLs.** The
    filesystem is externally mutable; a file-level ACL would drift on the
    first `git checkout`.

## Consequences

- Users make zero privacy decisions during capture by default: destination
  and consequence are shown before typing, the default is inferred, and
  choosing another destination is one click. Writing to a team still
  requires a Project entry point or one explicit filing action.
- Personal Spaces become high-traffic. Their capture inbox has to be good, or
  users will route around it.
- The strongest isolation boundary now has a controlled opening; every
  cross-Space read path must be enumerated and individually justified.
- Derived outputs default narrower than before; some team output needs one
  explicit publish. That is the intended trade.
- The read audit log is a privacy-relevant asset of its own, readable by the
  resource owner only.

## Non-goals

- Defending against a deliberate insider with legitimate access.
- File-level access control inside Project Folders.
- Attributing fused cross-Space conclusions — the system declines rather
  than guesses.

## Deferred

Tracked with triggers in
[`tasks/deferred-register.md`](../tasks/deferred-register.md): ownership of
orphaned `private` rows after a member leaves; explicit consent to
`oversight_mode` when joining an existing Space; detail-read auditing beyond
Task, Activity, Artifact, and note/`space_object`.
