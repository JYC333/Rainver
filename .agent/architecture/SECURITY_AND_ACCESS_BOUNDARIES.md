# Security and Access Boundaries

This document records the durable access control principles for the Rainver backend.
It covers authentication boundaries, space isolation, object visibility, session and task
policy, activity policy, proposal/memory governance, intentional cross-space exceptions,
credential secrecy, path safety, and current dogfooding readiness.

---

## 1. Authentication Boundary

All durable-data API routes require authentication via `get_identity()` or
`get_current_user()`. An unauthenticated request to any such route must return 401.

### Intentional public endpoints

| Endpoint | Rationale |
|---|---|
| `GET /health` | Health probe for load balancers and monitoring |
| `GET /api/v1/features` | Frontend feature-gating bootstrap |
| `GET /api/v1/auth/google-configured` | OAuth login flow bootstrap (boolean only) |
| `GET /auth/google` | OAuth redirect initiation |
| `GET /auth/google/callback` | OAuth callback; CSRF state validated by cookie |
| `POST /auth/logout` | Cookie deletion only; no secret access |

All other routes, including system-metadata endpoints, are auth-gated:

- `GET /capabilities`, `GET /capabilities/{id}`, `POST /capabilities/reload`
- `GET /api/v1/server/catalog`, `/catalog/capabilities`, `/catalog/agent-templates`
- `GET /api/v1/server/notifications/webhooks/policy`, `POST .../webhooks/dispatch`
- `GET /jobs/handlers`
- `GET /api/v1/system/backups`, `POST /api/v1/system/backups/manual` — instance-admin gated
- `POST /hosts/{hostId}/installations/{adapterType}`, `.../rollback`, `DELETE .../{installation}` — instance-admin gated for the built-in host, owner-gated for a paired machine
- `GET /providers/vendors`, `/providers/presets`

---

## 2. Space Isolation

Durable objects are scoped by `space_id`. All service queries that look up objects by ID
must include a `space_id` filter. A cross-space lookup must return 404 — not 403 — so
the response does not reveal whether an object exists in another space.

Rules:
- Raw `Model.id == id` queries without a `space_id` filter are forbidden in authenticated
  service methods.
- Space_id comes from `get_identity()`, not from a request body field or a fetched object.
- User-space authority comes from `SpaceMembership`. `User.space_id`,
  `User.default_space_id`, and global `User.role` are not part of the backend
  schema.
- Cross-space access fails closed (404) unless the route is an intentional exception
  documented in section 8.
- Durable object `project_id` associations are not read grants. List filters and writes
  that accept `project_id` validate that the project exists in the current space
  (`assertProjectInSpace`) before using it; missing, deleted, or cross-space projects
  return HTTP 422.

---

## 3. Content Access

All persisted content uses one read model. An active membership in the
resource's Space is required first; project_folder/project scope gates are applied
second; owner, visibility, and explicit grants are evaluated last. Visibility
has exactly three values: `private`, `space_shared`, and `selected_users`.
Unknown values fail closed.

Invocation Delivery and safe Invocation Snapshot records contain references,
budget decisions, semantic roles, and content hashes, not rendered prompt or
context bodies. Optional raw replay is stored only as a separately encrypted
Sealed Payload under a positive immutable retention control. It has no normal
product read path: a dedicated authorizer must revalidate and lock permission in
the payload-read transaction, successful plaintext access is audited before the
read returns, and deleted, expired, unauthorized, metadata-tampered, or
cross-Space reads fail closed.

### Creation context

User-initiated content creation has one access-owned authority:
`resolveContentCreationContext`. It resolves Space, Project scope, and initial
visibility as one decision. A creation inside an active Project requires a
Project writer and produces `(project.space_id, project.id, space_shared)`.
A creation with no Project context ignores the browsed Space and produces
`(the user's unique Personal Space, null, private)`. Request-supplied
`space_id` and `visibility` never override this result.

This rule applies across root resource types, including Agent/template
creation, Runs and conversations, Activity, Tasks/Boards, Memory,
Knowledge/Notes, Sources, and relation/academic objects. System materialization
and child-resource writes, including Reader annotations, do not invent a new
context: they inherit the source row's Space, Project, owner, visibility,
access level, and grants.

Reader annotations are the one deliberate exception (ADR 0013 decision 5).
They inherit their document's Project scope but default to `private` even on a
`space_shared` document, because a margin note is personal marginalia and full
inheritance would publish it the moment it is typed. The author may opt in to a
wider visibility, bounded by the document's own — an annotation can never be
more widely visible than the thing it annotates — and grants are inherited only
when the annotation itself is `selected_users`.

The user-facing access ladder is **only me → in this project → whole Space**;
`selected_users` is a separate explicit share. Moving an existing row into
another Project remains an explicit filing operation, and filing a personal
capture into a Project is `POST /me/filings` (section 8e).

The canonical in-memory decision, SQL predicate, resource registry, and grant
query live under `server/src/modules/access/contentAccess*.ts`. Explicit grants
are normalized in `content_access_grants`; module-local owner/visibility SQL is
not an authorization boundary. Enforcement applies at:

- list endpoints
- detail endpoints
- sub-resource endpoints (runs, artifacts, proposals attached to a parent object)
- export endpoints
- mutation endpoints (PATCH, DELETE)
- consolidation / process endpoints

Denials return 404 ("not found"), not 403 ("forbidden"). This is the correct fail-closed,
no-oracle behavior — the caller cannot distinguish "not found" from "not permitted."

`private` content is owner-readable, `space_shared` is readable to scope-eligible
members, and `selected_users` is readable to the owner and active same-Space
grantees. `access_level=summary` withholds full content from non-owners.
**It fails closed:** `bodyWithheld` (`access/contentAccessTypes.ts`) serves a
body only when the viewer's computed level is exactly `full`, so an
unexpected level value withholds. Every serializer that carries a body takes
only a row with the level computed: `WithAccessLevel<Row>` (Agents,
artifacts, activity, knowledge items, claims, knowledge sources, notes,
source items, evidence, post-processing decisions, memory), `VisibleRunRecord`
for Runs, or an explicit level for Run detail records. The base row types have
no level field, so a read path that forgot to compute the level does not
compile. Write responses (Agent, activity, source item, evidence, knowledge
source) are read back through the gated query, so they carry the writer's
level instead of withholding from their own author.

A summary viewer is withheld, on these surfaces:
- **Knowledge / Notes:** detail bodies, list previews, retrieval text, note
  `content_hash`, and note revision history (a summary reader gets 404 there).
- **Knowledge sources:** `raw_text`, `content_ref` and metadata.
- **Claims:** `claim_text`, `subject_text` and metadata, and the claim
  evidence's quote and locator.
- **Item↔source links and item `source_refs`:** the link quote and note, and
  the evidence excerpt.
- **Activity:** `content` and `metadata_json`.
- **Artifacts:** inline bodies and export.
- **Runs:**
  - `output_json`, and the turn / turn-stream body;
  - on `/trace`, the step input/output summaries, event summaries, and
    error text and metadata;
  - the free-text and JSON detail of attempts, supervisor decisions,
    evaluations, finalizations and verifications;
  - a Task's run list.
- **Agents:** `system_prompt` on the Agent row, version snapshots, and every
  write response, which is computed for the acting user.

Reader
`research_notebook` uses the same `space_object` gate as Notes and requires
`full` to return a body. Project Folder
and project scope are independent from visibility. Space owner/admin roles may
manage access policy but do not bypass read policy **by default**; the single
exception is the creation-time, immutable Space oversight mode (below), scoped
to reads within that Space.

Every persisted context-snapshot item records the source content's owner and
visibility, taken from the canonical retrieved row rather than the instructing
user. The Run aggregates those rows into `context_taint_json`: the
narrowest input visibility and the distinct owners other than the instructing
user. Durable Run outputs consume that summary. An output influenced by another
user defaults to `selected_users` for the instructing user and contributing
owners; a direct visibility widening is rejected. Publication to the whole
Space uses an `egress_review` proposal and requires an unrevoked
`egress_granting_user` approval from every contributing owner before the
proposal applier may widen the target.

Successful reads through the registered content boundary are privacy-audited
in `content_access_logs` only when `viewer_user_id <> owner_user_id`; a database
CHECK makes owner-read rows impossible. Retrieval audits only final,
live-revalidated results, never filtered candidates. Ordinary detail reads audit
through `recordDetailRead` (`access_type = 'detail_read'`) on Task, Activity,
Artifact, and note/`space_object` fetches, so a demotion disclosure does not
report an empty reader list for content that is read through a detail endpoint
rather than through retrieval. The resource owner is the
only default reader of these logs (`GET
/api/v1/content-access/{resource_type}/{resource_id}/access-logs`). The existing
retention scheduler prunes this shared table.

Visibility demotion is forward-only. Narrowing a resource first requires an
owner-only disclosure request that lists recorded readers, Runs whose immutable
Invocation Snapshot source refs consumed the resource, and artifacts/proposals from those Runs
that remain non-private, with UI links. The subsequent policy update must carry
the short-lived confirmation id. Confirmation locks the disclosure, recomputes
the exposure inside the policy transaction, rejects any changed snapshot, and
consumes the id atomically with the update. Admin policy-management authority
does not authorize confirming another owner's demotion.

### Additional project scope (cross-Project sharing)

Project scope is the one gate a per-user grant cannot reach past: it is a hard
AND evaluated before visibility and grants, so an object owned by Project A is
unreadable to a non-member of A however many grants exist. Widening it therefore
needs its own term, declared rather than hand-written (B12G).

`ContentAccessibleDeclaration.projectShare` names a table, a resource column, a
project column and a revoked column; the registry composes an `OR EXISTS (…)`
inside the project-scope conjunct from those identifiers, and callers never pass
SQL. Exactly one resource declares it — `space_object`, backed by
`space_object_project_shares`. **Where it is not declared the term is not
emitted at all**, so every other resource's predicate is unchanged rather than
equivalent (`server/test/contentProjectShareDeclaration.test.ts`).

What a share is and is not:

- It widens **scope only**. `visibility`, `access_level` and
  `content_access_grants` are separate conjuncts evaluated afterwards, so
  sharing a `private` object into a Project does not make that Project's members
  able to read it. A share removes the Project barrier; it is not a grant, and
  it carries no access level.
- **Governance ownership does not move.** `primary_project_id` stays with the
  Project that first held the object.
- Both directions are writes: opening an object to a Project requires write
  access to that Project *and* to the one that owns the object, so a member of B
  cannot pull A's note into B.
- It is never a side effect. The note placement path refuses a cross-Project
  placement with `409 note_cross_project_share_required` until the caller
  re-issues with the share confirmed, and the drag/reorder path refuses
  outright — a permission change must not be disguised as a drag.
- Revoking withdraws the share **and** the object's placements inside that
  Project's folder subtree, so that Project's tree is never left with rows its
  members cannot read.

Boundary coverage: `server/test/noteCrossProjectShareDb.test.ts`.

On `space_shared` resources, `content_access_grants` rows are per-user
disclosure *upgrades*, not narrowing: the effective level is the widest of the
resource's own `access_level` and any active grant for that viewer (a
`summary`-base resource can grant a specific member `full`; a grant never pulls
a `full`-base resource down to `summary`). On `selected_users` resources, an
active grant's `access_level` is authoritative for the grantee — it is not
narrowed by the resource's own `access_level`.

Space membership roles remain separate from persisted policy rows. Shared role
helpers live in `server/src/modules/access/roles.ts`, and route-level
owner/admin responses are centralized in `server/src/modules/routeUtils/access.ts`.
These helpers do not replace `PolicyGateway`; sensitive action gates still go
through the policy module.

### Space oversight modes

A Space chooses, at creation time only, how much read visibility its
owner/admin members get over other members' otherwise-private content within
that same Space. The mode is one of `none` (default), `summary`, `content`,
`full` — strictly increasing capability — stored on `spaces.oversight_mode`
and immutable after creation. Personal Spaces are always `none` (there is no
request body in the OAuth-bootstrap creation path, so the column default is
the only enforcement). The mode is visible to every member of the Space
(transparency requirement); there is no admin toggle and no update path that
accepts the field.

Oversight is implemented inside the canonical predicate
(`contentAccessSql` / `contentAccessLevelSql` / `decideContentAccess` in
`server/src/modules/access/`) as a widest-wins merge with the ordinary
visibility/grant result, so every registered content resource type inherits it
from one place — not a per-resource special case. Concretely, for an active
owner/admin member of a Space with oversight enabled: `summary` mode
contributes `summary` access to that member's otherwise-invisible content;
`content` and `full` both contribute `full` access to ordinary content.
`highly_restricted` memory is the one gate oversight does not automatically
pierce: only `full` mode pierces it (`memoryReadAuth.ts`); `none`, `summary`,
and `content` all still deny it, and neither an owner's explicit grant nor a
lower oversight mode pierces it either (sharing `highly_restricted` content
requires an explicit, auditable sensitivity downgrade by its owner, not an
oversight escalation).

Oversight applies to **reads only**. It does not extend to publishing,
visibility changes, grant management, proposal creation, or any other write
path — those keep their current owner/role requirements. In particular,
`contentAccessSql` / `contentAccessLevelSql` / `contentReadSql` take an
`includeOversight` flag (default on) specifically so that queries whose output
becomes a new, more-widely-visible artifact can opt out: project public
summary generation (`projects/publicSummaryGenerator.ts`) passes
`includeOversight: false` on every candidate query, because its output can
become `review_status = 'approved'` and readable by the whole Space — an
oversight admin's own extra visibility must never leak another member's
private content into that space-wide artifact. A **thread reference** does the same
(`rooms/threadReferences.ts`, through `importedSessions/read.ts`): a person may
open a colleague's private transcript by oversight, which is audit, but copying
it into a thread other people read is publication, so the copy is read with
`includeOversight: false` under the attacher's own identity. See "Copying
content across an audience boundary" below.

Retrieval and per-run context injection do inherit oversight by design (an
admin-initiated run may compile other members' otherwise-private content into
that run's own context/output, scoped to that run), which is a deliberate
consequence of the same canonical-predicate mechanism, not a separate
feature.

Oversight does not pierce project_folder/project scope gates, source consent
gates, **the Room boundary**, or any other post-visibility deny gate besides
the `highly_restricted` exception above. A Room is a visibility boundary
([ADR 0018](../decisions/0018-room-as-visibility-boundary.md) decision 3), and
because oversight sits *inside* the visibility disjunction it would otherwise
admit an admin who is a member of the Project but not the Room. Every read of
Room-derived output therefore carries `roomRunReadAccessSql` alongside
the content predicate, so a list cannot show what its detail page then 404s
on. It is applied by `runs.listRuns` and `runs.getVisibleRun`; the Home and
cross-space Run lists and the failed-run count, and the Home Proposal and
Artifact lists (`access/contentAccessSql.ts`'s `runReadSql`,
`proposalReadSql`, `artifactReadSql`, which `frontendSupport` calls); the Project Pulse in-progress count; and the canonical
Proposal and Artifact repository reads. It also gates Proposal accept, reject
and egress approval (`proposals/applyService.ts`), so widening it widens a
write authority — which is why the predicate has no mainline exemption even
though the mainline's `room_user_members` row is written lazily, on first open
of the Project. Not seeing a mainline Run until you have opened the Project
once is stricter and self-healing; exempting the mainline would have let a
Project member who never opened it decide that Run's Proposals.

Some reads are covered by their parent rather than by this predicate.
`listRunIdsForGroup`, `listArtifactIdsForRuns` and `listProposalIdsForRuns`
sit behind `requireReadableGroup`, which checks Room membership directly.
`listTaskRuns`, `listTaskArtifacts`, `listTaskProposals` and
`listTaskEvaluations` carry both terms: the content predicate and the Room term,
through the shared `runReadSql` / `proposalReadSql` / `artifactReadSql` in
`access/contentAccessSql.ts`. An evaluation and a Project work event are judged
by the Run that produced them (`runInheritedReadSql`), and a work event names
its Run inside `data_json`. The Board and Task work-view run, evaluation, and
output columns (`boardReadModel.ts`) read through the same helpers, so a shared
Task cannot surface another member's private Run status, evaluation summary, or
output types — from a Room or otherwise. Task dispatch refuses a `session_id`
that names a Room conversation, so no Room-scoped Run reaches `task_runs` in the
first place; the Room term on those lists is the second of the two.

**The close gate is computed in the asking person's view.** `taskCompletionState`
and `missingRequiredOutputs` take a required viewer: an optional one meant a
caller that forgot it judged the Task against the whole ledger, so a close that
succeeded, or a shorter `missing` list, told the person that an evaluation or an
output they cannot see exists. The settlement worker, which decides what actually
happened to a Task and must see every output, says so by name
(`missingRequiredOutputsForSettlement`). `listPolicyDecisionRecordIdsForGroup`
and the group timeline's `listDelegations` join each delegation's parent (and
child, when present) Run and apply the Run content predicate, so a readable
group does not leak PDR ids or delegation text from a private child Run. The daily-report artifact
reads (`dailyReports/`) carry no Room term either; in practice they are
restricted to the viewer's own non-Room artifacts, but they have not been
audited against this rule. Cross-space reads always fail regardless of oversight;
targeted publications remain the only cross-space transfer path.

### Usage events

`token_usage_events` is registered as `token_usage_event` in the canonical
content resource registry. Direct user and CLI-import events are private and
owned by that user. Run/Agent-backed calls snapshot the source resource owner,
project_folder/project scope, visibility, disclosure level, and active disclosure
grants for both `selected_users` and `space_shared` sources at call time. Ownerless events are accepted only for an explicit
Space-system task and must be `space_shared`.

Every user dashboard query applies the canonical SQL predicate to event rows
before aggregation. `summary` access contributes only to a de-identified
summary group; event, session, dimension, and budget-subject details require
effective `full` access. Detail filters also exclude summary-only rows to prevent
filter-difference inference. Space owner/admin and instance-admin roles do not
bypass this predicate. The instance-admin operations endpoint returns only
aggregate totals and no user, prompt, run, session, or source-resource dimensions.

### Imported CLI history

`imported_sessions` is registered as `imported_session` in the canonical
content resource registry. A session imported from a paired host lands with the
visibility its owner chose at import time and is read through the canonical
predicate like any other Project content — a shared one by Project members, a
private one by its owner alone, with a fail-closed 404 and no existence oracle
either way.

Two rules are specific to it and are load-bearing:

- **A transcript requires effective `full` access, not merely a non-deny
  decision.** `summary`, which oversight grants an admin over a colleague's
  private content, does not open one: the transcript *is* the content, and this
  is someone's own terminal history.
- **Only sessions at `space_shared` can be extracted from.** A Project Brief has
  no per-object visibility, so a private session feeding extraction would
  publish its content to every Project member through the Brief. This is
  enforced in the extraction query, not by the caller.

Mutating paths — importing, changing a Location's import policy, changing a
session's visibility, deleting — additionally require the host's registered
owner ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)'s hard
rule), except that a session whose Location has since been unregistered stays
administrable by its owner so unbinding a folder cannot strand its history.
See [modules/imported-sessions.md](../modules/imported-sessions.md).

### Copying content across an audience boundary

A **thread reference** copies content a person picked into another thread. It
is the one path that deliberately moves content between audiences, so it is
gated twice.

The copy is read under the **attacher's own identity**, with
`includeOversight: false`. Oversight is audit; a copy other people will read is
publication, and an admin's audit reach must not become a route to publish.

Where the destination's audience is wider than the source's, the attach is
**refused** with a coded 409 naming `gains_access_user_ids`, and proceeds only
when the request confirms it. The confirmation is server-enforced, not a client
courtesy, and it must name people — the client echoes back the ids the refusal
gave rather than a bare `true`, because a roster can grow in between.

Audiences are computed by asking the read gates themselves, never by a second
description of them — the roster is not the mainline's audience, and a Room
membership is not a Project readership. Which gate answers for which kind of
source is [modules/rooms.md](../modules/rooms.md)'s to state, and stating it
twice is how the two drift.

Generating an imported session's summary is a metered model call charged to
that session's **owner**, so both gates — source readability and destination
reachability — run before anything is spent, under the caller's identity.

See [modules/rooms.md](../modules/rooms.md) and
[ADR 0018](../decisions/0018-room-as-visibility-boundary.md).

### Commands on shared records

Reading a record and acting on it are different standings. Each kind of
command has one authorizer, and every path that issues the command goes
through it:

- **Agents.** `assertAgentOwner` (`agents/agentAccess.ts`) gates identity,
  config, version restore and runtime-profile writes: the owner; for an unowned
  system-managed Agent, the Space's owner or admin; never the Assistant, whose
  runtime profiles follow its Project's writers. An automation may name only an
  Agent its creator can read.
- **Inquiry Threads.** `assertThreadReadable` (`inquiry/threadAccess.ts`) is the
  root's content predicate, 404 on refusal, on every Thread path: sub-resources,
  signals and candidates, advice, retrieval, and knowledge extraction and
  promotion. Its purpose argument keeps Space oversight to reads: a change needs
  the person's own reach, and a publication such as a Delta Brief draws only on
  Threads shared with the Space. Only a Thread's owner reassigns it; a child or
  superseding Thread, and a Knowledge candidate taken from a Thread, start no
  wider than their source.
- **Runs.** `authorizeRunCommand` (`runs/runCommandAuthority.ts`) gates
  execute, stop, finalize, resume and abandon: the Run is visible, and the
  caller is its owner or instructing person. Granting a policy pause's approval
  is decided instead by approval authority over the recorded risk
  (`roleMayApproveRisk`). A child Run's parent must be readable by its creator,
  child lists apply the Run predicate, and a person-started create refuses
  `trigger_origin` and `run_type: system`.
- **Proposals.** `authorizeProposalDecision` gives accept, reject, rollback and
  egress approval one reach rule (same Space, the decision's state, readable,
  inside a readable Room for a Run's proposal); each decision adds its own
  authority.
- **Roles.** `assertCanGrantRole` (`access/roles.ts`) gates every role grant: a
  known role, no higher than the granter's, and owner only from an owner — Space
  invitations and Project member add, role change or removal (taking a role away
  needs the standing to grant it). Room roles never come from a request:
  invitations add `member`, and only the current owner transfers ownership. The
  one other way to Room ownership is claiming a suspended Room — one whose owner
  can no longer write the Project — by the Project owner or a Space owner/admin,
  a recovery path rather than a grant between people.

---

## 4. Session Access Policy

Public `/sessions*` conversations are non-Room sessions owned by one user
within a space. Room conversations are shared, Project-bound aggregates and
are readable/writable only through `/rooms/{roomId}/conversations/*`.

- `GET /sessions/{id}` requires authentication. `space_id` and `user_id` are extracted from
  the request identity and forwarded to `SessionService.get_session()` as SQL filters.
- `GET /sessions/{id}/messages` follows the same pattern.
- A cross-space request returns 404 (session not found in that space).
- A same-space non-owner request returns 404 (session belongs to a different user).
- A Room session returns 404 on every public `/sessions/{id}` read, message
  write, and reflection command. RoomService rechecks active Room membership
  and the Project ACL before its own reads and dispatch.
- Public `POST /sessions/{id}/messages` accepts only `content`; the server
  assigns `role='user'` and does not accept client metadata. Assistant role,
  Run identity, artifact references, and action previews are server-owned.
- An unauthorized request must not return any message content.
- Room `room_display = internal` instructions stay off the human transcript,
  the Project conversation list preview/count, and conversation summaries.
  Agent replay still reads them.

Enforcement is at the SQL query layer: `Session.space_id == space_id`,
`Session.user_id == user_id`, and `Session.room_id IS NULL` are all applied as
WHERE-clause filters. Room-specific repository commands use the Room,
conversation, Project, and membership relations as one scope.

---

## 5. Task Access Policy

Tasks enforce visibility on all read, mutation, and sub-resource paths.

- `GET /tasks` and `GET /tasks/{id}` use the canonical content predicate.
- `PATCH /tasks/{id}` and `POST /tasks/{id}/runs`: visibility enforced before mutation.
- Sub-resource endpoints (`GET /tasks/{id}/runs`, `/artifacts`, `/proposals`): `user_id`
  is forwarded to `TaskService.get()` so task visibility runs before the
  sub-resource query.
- `GET /boards/{board_id}/tasks`: task visibility is applied per-row to the
  result set before returning. Private tasks are filtered from the board view
  for non-owners.

Private tasks are not readable by same-space non-owners.

---

## 6. Activity Access Policy

Activity records enforce visibility on read, mutation, and consolidation paths.

- `GET /activity` and `GET /activity/{id}` apply the canonical SQL predicate.
- `PATCH /activity/{id}/review` and `PATCH /activity/{id}/archive`: `viewer_user_id`
  forwarded to the service; non-owners of a private record receive 404.
- `POST /activity/{id}/consolidate`: `svc.get(activity_id, space_id, viewer_user_id=…)` is
  called before consolidation begins; non-owners of a private record receive 404.

An unauthorized consolidation attempt must not create proposals. If visibility check fails,
the handler returns 404 before calling the consolidation service.

---

## 7. Proposal and Memory Boundary

Activity does not directly become active memory:

1. `ActivityConsolidationService` creates **proposals** from activity records.
2. Proposals must be reviewed and accepted via `POST /proposals/{id}/accept`.
3. `ProposalApplyService` handles the durable mutation — the only path through which
   activity-derived content becomes memory.

Additional invariants:
- Proposal apply is space-scoped: `accept(id, space_id=…)` returns None on space mismatch.
- Unsupported proposal types (`task_create`, `plan_create`, and any unknown
  type) raise `UnsupportedProposalTypeError` and leave the proposal in `pending` status.
  The fail-closed behavior is tested.
- Memory writes require policy/proposal gating: there is no public direct-write
  active-memory path accessible without policy enforcement.
- Person-facing run create (`POST /api/v1/agents/:agentId/runs` and Task
  dispatch) always records `trigger_origin = manual`. The client cannot label a
  live turn as unattended to apply a persona without in-turn owner review, or
  treat an attended write as automation. Unattended origins are stamped only by
  scheduler and automation writers.
- A persona write applies from an unattended Run only when the person
  responsible for that work — the root Run's `instructed_by_user_id` — is the
  Agent's owner (ADR 0003 §5). Another member's Automation, autonomy tick or
  job leaves a proposal pending for the owner, exactly as their turn would, so
  scheduling work against an Agent is not a way to rewrite what every Room it
  sits in will see. Unattended writers stamp the responsible person: firing an
  Automation without supplying a prompt runs the Automation owner's configured
  prompt and is instructed by that owner, not by whoever pressed fire. That
  holds for the two targets that run an Agent — `agent_run` and `workflow`.
  The retrieval-maintenance, context-ops and information-digest targets still
  stamp the firing person on their `automation` Runs; those Runs run in
  process, dispatch no system action and reach no memory write, and their
  person is the owner of the owner-private output they produce.
- Publication import of a memory snapshot writes through
  `PgMemoryApplyRepository.applyPublicationImport`: a new private user-scope
  row attributed to the importer, with user-confirmation provenance. It does
  not insert `memory_entries` from the publications adapter, and it cannot
  import agent-scope types.
- `MemoryProposalApplier.apply_create()` and `apply_update()` block grant-derived proposals
  from applying to non-personal target spaces without prior egress approval.

### Project-level memory access (retrieval surfaces)

Memory rows may carry a `project_id`. The **memory retrieval** surfaces
(`POST /memory/retrieval/search` and `POST /memory/create-safety`) enforce
project membership inside the memory adapter's `revalidate` gate, in addition to
`canReadMemory` + summary-only redaction:

- Personal space (single member): the sole member can access every project.
- Shared (team/household) space: the project `owner_user_id`, or a user with an
  `active` row in `project_members`. Everyone else fails closed.
- `project_id = null` memory is not project-gated. A missing/deleted/cross-space
  project fails closed.

The gate covers **all user-facing memory read surfaces**: the retrieval surfaces
(adapter `revalidate`) and the legacy `PgMemoryReadRepository` paths (`GET /memory`,
`GET /memory/{id}`, `POST /memory/search`, batched after `canReadMemory`).
Membership is managed via the projects module
(`GET/POST /api/v1/projects/{id}/members`, `DELETE …/members/{userId}`; add/remove
require the project owner or a space owner/admin).
Proposal apply preserves the same association: memory proposals carry
`proposals.project_id` through to `memory_entries.project_id`, after validating the
project still exists in the proposal space. Missing/deleted/cross-space projects
fail closed before any active memory row is created.

### Project public summaries (high-level discovery)

`project_public_summaries` is a separate discovery layer, not a bypass around
project memory ACL. Approved rows are intentionally readable within the current
space and indexed as retrieval object type `project_public_summary` so projects
can inspire each other at a high level.

Public-summary writes require project writer authority: the project
`owner_user_id`, a space `owner`/`admin`, or an active project member role of
`owner`/`member`. A project member role of `viewer` can read concrete project
memory through the memory ACL but cannot mutate project metadata or public
summary rows.

**Publish governance.** A bare write stages `review_status = draft`. Flipping
the row to a space-public state (`approved`) or removing it (`archived`)
requires project-**owner**-level authority — the project `owner_user_id` or a
space `owner`/`admin` (`assertProjectOwnerLevel`). A project `member`/writer can
stage a draft but cannot self-approve, so the owner reviews before content
becomes space-public. The draft generator only ever writes `draft`.

**Database-level consistency.** `projects` has a composite candidate key
`UNIQUE (space_id, id)`; `project_public_summaries` and `project_members` carry
a composite FK `(space_id, project_id) → projects(space_id, id)`. A summary or
ACL row cannot be associated with a project in another space even via raw SQL.

**Project metadata visibility.** `projects.settings_json` is free-form
configuration and may hold private operational detail; `GET /projects` and
`GET /projects/{id}` redact it to `null` for non-writers. `name`,
`description`, and `current_focus` remain space-visible descriptive metadata.

The summary payload must stay redacted: `summary_text`, `topics_json`, and
`highlights_json` are high-level fields; `source_refs_json` is pointer metadata
only. It must not embed raw private memory, memo/document excerpts, artifact
payloads, Project Folder file content, or other concrete project content. The
Projects search route only permits `project_public_summary`, so it cannot be
used to probe Knowledge or Memory retrieval projections.

The draft generator
(`POST /api/v1/projects/{id}/public-summary/draft`) follows the same writer
authority rule and writes only `review_status = 'draft'`. Its prompt version is
`project_public_summary.prompt.v1`; provider routing uses auxiliary task
`project_public_summary` unless the request supplies a model provider. The
generator bounds and filters the source context before the model call: no
Project Folder files, no artifact file bodies, no `highly_restricted` memory, and no
sensitive/restricted memory content. Model-returned source refs are accepted
only when they match source IDs that were actually supplied to the prompt. The
generator writes a best-effort `policy_decision_records` audit row
(`action = project.public_summary.generate`, `decision = allow`) recording that
authorized project context was sent to a provider — pointer metadata only
(counts, provider id, model, prompt version), never project content.

Approved summaries are also a candidate source for the shared system assistant:
the chat candidate collector includes a `project_public_summary` source so the
assistant can surface cross-project inspiration. Only the sanitized,
space-public summary is read; concrete project memory remains behind the
`project_members` ACL.

**Runtime:** Runtime Context acquisition applies the Project cut before planning
or rendering. A Run bound to Project P may acquire P's Memory only when the
`instructed_by_user_id` can access P, plus Project-free Memory; a Run without a
Project acquires Project-free Memory only. The Gateway reauthorizes those rows
again when persisting the Delivery. Memory retrieval remains current-Space only;
cross-Space Memory retrieval is not implemented.

---

## 8. Intentional Cross-Space Exceptions

These routes intentionally ignore or discard the request `space_id`. Each has its own
authority mechanism in place of space-scoped auth.

### 8a. Personal Memory Egress Approval

**Route:** `POST /proposals/{proposal_id}/approvals/egress-granting-user`

The proposal lives in the **target space** (the space where the run executed). The granting
user authenticates from their **personal space**. These are structurally different spaces.
Requiring `proposal.space_id == request_space_id` would make granting-user approval
impossible in the standard case.

**Do not add `proposal.space_id == request_space_id` to this route.**

Authority comes from the guard chain inside `record_egress_granting_user_approval()`:

| Guard | Invariant |
|---|---|
| `grant.granting_user_id == approver_user_id` | Only the exact user who created the grant may approve |
| `proposal.space_id == grant.target_space_id` | Proposal must belong to the specific target space |
| `source_run_id == grant.target_run_id` | Proposal must trace back to the specific run the grant covered |
| `run.space_id == grant.target_space_id` | Source run must be in the same target space as the grant |
| `run.instructed_by_user_id == grant.granting_user_id` | Run must have been instructed by the granting user |
| Deadline check (`egress_review_expires_at`, `proposal.expires_at`) | Approval window enforced |
| Payload safety markers | `raw_private_memory_included`, `personal_summary_persisted`, public `target_visibility` all blocked |

Request `space_id` is intentionally discarded (`_, user_id = ids`). Security authority is
user-centered, not request-space-centered.

### 8b. PersonalView (`/me`) Cross-Space Aggregation

`GET /me/summary`, `/me/timeline`, `/me/tasks`, `/me/pending` are intentionally cross-space.
They aggregate across all spaces the user is a member of (`_member_space_ids(db, user_id)`).
Visibility filters are applied to tasks and proposals. No raw
artifact payloads or full memory content is returned — pointer metadata only in timeline.

### 8c. Targeted Publications

`/publications` never resolves a live source resource for a target Space. Publishing
requires source ownership/full access plus active membership in every explicit target.
Discovery requires active membership in the current target Space. Import verifies the
immutable snapshot hash and creates a new private target-Space resource through
the owning domain writer (Memory uses `PgMemoryApplyRepository`). Revocation
blocks future imports without deleting existing copies. After revoke, list and
GET still name the publication to a target Space that already imported, but
they return an empty snapshot payload there; only the publisher still receives
the snapshot body. The imported copy is the surviving content, and it stays
private to the importer.

### 8d. PersonalMemoryGrants

All five `/personal-memory-grants` routes discard request `space_id`. Grants are
user-centered objects that span two spaces by design: the personal space (where private
memory lives) and the target space (where the run executes). Authority is `granting_user_id`
throughout.

### 8e. Personal aggregated retrieval

The content-bearing cross-Space exception is restricted to this explicit route
set; no ordinary detail, list, search, context-build, or mutation route inherits
it:

- `POST /me/retrieval/search`
- `POST /me/retrieval/pointers/resolve`
- `POST /me/retrieval/summaries`
- `POST /me/retrieval/egress/disclose`
- `POST /me/retrieval/fused-conclusions`
- `POST /me/filings`

`POST /me/filings` is the personal-capture filing path, and it carries content
in the opposite direction. It reads nothing across the boundary: it loads a
capture the caller owns in their own personal Space, re-checks writer authority
on the target Project through `resolveContentCreationContext`, and creates a new
object there. The capture is neither copied nor moved — it stays put, is marked
`processed`, and records where it went in `payload_json.filed_into`.

The retrieval route enumerates the protocol retrieval vocabulary and executes a
separate `RetrievalSearchService` pass for every active member Space. Each
domain adapter revalidates against the resource in that source Space; its
`contentAccessSql` membership, scope, visibility, grant, access-level, and
oversight rules are never replaced by a union predicate. Single-resource routes
remain same-Space and return 404 across the boundary.

Only `(resource_space_id, resource_type, resource_id)` rows persist in
`cross_space_retrieval_pointers`; titles, snippets, excerpts, and synthesized
text are absent. Pointer resolution calls the owning adapter's live
`revalidate`, so membership or grant revocation takes effect without cleanup.
The user's query may persist in the pointer session because it is their own
message, not retrieved source content.

A summary whose pointers all resolve to one source Space is stored as an
owner-private artifact in that Space. A multi-Space conclusion is never written
by retrieval. Explicit storage requires a prior, unconsumed, short-lived
disclosure covering the exact pointer set; the private artifact lands in the
user's Personal Space with lineage. The same transaction writes one
`content_egress_records` row per source Space. Egress rows and member
notifications contain only actor/time/source-pointer metadata, never conclusion
text.

`spaces.egress_notifications_enabled` is mutable; Team Space creation sets it
on, while Personal/Household creation leaves it off. A real setting change
through `PATCH /spaces/{spaceId}/egress-notifications` creates a notification
for every active member and affects only later actions. An idempotent update
does not emit a duplicate notification. A
fused-store disclosure returns each source Space's captured setting before the
explicit store action; a setting change invalidates that disclosure and requires
redisclosure. Enabled source Spaces broadcast the resulting pointer-only egress
notification. `/me/notifications` returns only notifications for Spaces where
the recipient remains an active member.

---

## 9. Credential, Provider, and Runtime Secrecy

- Provider API responses explicitly exclude `api_key`. Decrypted keys exist
  only in-process at resolve time and are passed as a call parameter; they
  must not appear in a DTO, log, environment variable, or HTTP body,
  including `/internal/*`. There is no HTTP credential-resolve hatch, and no
  internal route that spends a key on a caller's say-so.
- Structured request logs carry no headers at all: Fastify's default `req`
  serializer emits method, url, host and remote address, and nothing else, and
  no route logs a request or response body. The redact paths in
  `gateway/logging.ts` are defense in depth for the day a serializer changes —
  they are unreachable while the default one is in place, and are listed here
  as belt-and-braces, not as the mechanism. pino matches a redact path exactly,
  with no substring rule, so each spelling is listed on its own:
  `authorization` **and** `proxy-authorization`, `cookie`, `x-api-key`,
  `api-key`, `x-goog-api-key`, `anthropic-auth-token`,
  `x-rainver-internal-token`, and the response's `set-cookie`. Provider error
  bodies logged from 5xx routes pass through `redactSecretPatterns` before
  persistence — that one is a live path, not defense in depth.
- ModelProvider credentials are user-owned resources. Active-space use is
  controlled by explicit grant rows; ungranted use fails before secret
  resolution. Provider edit and key replacement are owner-only; Space
  owners/admins may disable grants for their Space without reading or editing
  secret material.
- One authorizer, `authorizeCredentialSpend` (`policy/credentialSpend.ts`),
  decides every ModelProvider spend before a key is resolved or a proxy lease
  is minted. The provider invocation layer calls it for every chat, embedding
  and rerank call; a proxy lease cannot be created without its result; and the
  Run executor calls it before a server-host Run starts. Each spend names its
  basis:
  - a person in the request being served (`manual`);
  - a Run, decided on its root Run, since a delegated, Plan or Workflow child
    has no authority of its own. An `automation` or `autonomous` root spends
    only while the Automation that fired it holds an active credential grant,
    read at spend time through `automation_runs`, so revoking the grant stops
    a Run queued under it;
  - an unattended job's setup, re-read at spend time: a scheduled daily
    report, scheduled imported-session extraction, Inquiry advice, Room
    conversation summaries and titles, Runtime Context checkpoints, retrieval
    embedding backfills, the research pipeline, and scheduled source
    post-processing. [modules/policy.md](../modules/policy.md) lists what each
    re-reads.

  An unattended spend with no authorization record is denied, not sent for
  approval, because nobody is present to approve it. A missing origin is never
  treated as `manual`.
- **A CLI's login is not a control-plane credential** ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)
  §7, B45–B49). It lives with the copy on the host that runs it, in that
  copy's own state directory. The control plane brokers none of it, stores no
  path to it, and has no row that could leak it: there is nothing here to
  redact because nothing arrives. Logging a copy in is an interactive PTY the
  daemon runs on the host and relays over the host WebSocket
  (`/api/v1/hosts/:hostId/installations/:adapterType/:installation/login/stream`);
  the terminal bytes cross the control plane but are never persisted.
- Runtime adapter versions are host state, not user or Space secrets, and
  there is no per-Space version selection: one version per adapter per host
  ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md) §9), replaced
  by drain-then-replace with one kept previous version as the rollback target.
  Install, rollback, uninstall and login on a **paired** host are its
  registered owner's alone. The same routes on the **built-in** host require
  instance admin (`requireInstanceAdmin`), because there is one copy per
  instance and every member spends it; they answer 403 rather than 404,
  since that host is on every member's list already. Install, rollback and
  uninstall are recorded in `host_runtime_changes`; a login is not — it changes
  no version, and the row's `action` column has no value for it.
- `AgentVersionOut`, `RunOut`, and `ArtifactOut` schemas contain no credential fields.
- Run trace exposes AgentVersion system prompt presence/hash metadata only; it
  does not inline raw system prompt text, raw rendered context text, or artifact
  content.
- Agent/run/artifact/proposal outputs must not expose secret material.

---

## 10. Project Folder and Artifact Path Safety

**Scope note (revised 2026-09-08, [ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):**
the control plane resolves no host path for *any* host (B64). Execution
isolation is a property of the host daemon's trust mode, not of this code
path: a **strict** host (the instance's built-in one) wraps every Run in a
rootless bubblewrap namespace the daemon builds on the machine
(`packages/host-daemon/src/strictNamespace.ts`); a **trusted** paired host
spawns natively with no namespace and no mount containment (B62). Neither
runs the server-side sandbox this section once described — it is deleted.
What remains below is the control plane's own file access: Artifact export,
and the Project Folder reads it serves. For Files & Code browse reads on any
host, the daemon runs the same shared `@rainver/folder-read` PathPolicy and
byte/file-count limits before returning data over the `folder_read` channel.

**Project Folder file access** (`server/src/modules/projectFolders/repository.ts`):
- A registered Project Folder is one shared workspace with no personal area.
  Its whole root is available to Project-authorized readers; personal material
  belongs in database-backed personal content. File-level ACLs are
  intentionally not a second source of truth for an externally mutable
  filesystem.
- `PathPolicy` (`@rainver/folder-read`) is enforced before any disk access.
- `project_folder.read` policy is enforced before tree/file/status/diff reads.
- Protected-Folder, external-root, protected/restricted, full-diff, and secret-like
  path reads force a durable `PolicyDecisionRecord`.
- Forbidden path patterns include `.ssh`, `.aws`, `.gcp`, `.azure`,
  `credentials`, `instance/secrets`, `config/secrets`, `.git/config`,
  `.env`, `.env.*` except template examples, private key filenames, and
  `*.pem` / `*.key`.
- Full git diff output is bounded; secret-like diff paths are denied and
  secret-like key/value lines are redacted.
- Forbidden write suffixes: `.py`, `.sh`, `.bash`, `.zsh`, `.fish`.
- Paths resolved to absolute before validation; no symlink race conditions.

**Strict-host Run isolation** (`packages/host-daemon/src/strictNamespace.ts`,
built on the host, not here): an empty root receives only system runtime trees,
exact DNS/NSS/linker/CA configuration paths (never the whole `/etc`), the Run's
HOME, its working directory bound per the Run's `sandbox_mode`, and the
explicit binds the daemon materialized for it — its run directory, a managed
copy's tree, the daemon's own package. Each is bound at its own path rather
than remapped, because the daemon is the only component that resolves paths.
Other Runs' workspaces, other Agents' profiles, the instance's secrets, its
internal token and the daemon's own registration are absent from both the
namespace and the environment. Network reach follows the Run's
`egress_profile`, but **only `none` is containment** — the namespace gets
`--unshare-net`. `default` and `install` point the Run's proxy variables at the
daemon's CONNECT proxy, which refuses and records; a process that ignores those
variables reaches the network anyway. See section 10's egress paragraph, which
states the same limit.
Namespace preflight failure is fail-closed.

**Artifact export** (`server/src/modules/artifacts/` and run artifact materialization):
- paths escaping the artifact storage root return no file.
- Paths resolving into the configured sandbox root are rejected
  (`artifacts/repository.ts`) — a defence-in-depth check kept after the
  server-side sandbox was deleted, since the root remains a configured
  location on the machine.
- Artifact read checks verify space and visibility before a stored file is resolved.
- Custom Source handler load and retention use the same relative-path + `isInside`
  refusal (`customSources/artifactStoragePath.ts`); a `../` `storage_path` cannot
  `require()` or unlink a file outside the artifact root.

**Official plugin personal rows.** Diary routes and jobs key every read and
write by `identity.userId`; the jobs API has no create surface, and a
reflection job's `user_id` is stamped at enqueue from that identity. Finance
`visibility = private` personal accounts are hidden from other Space members
on account list, ledger, balances, transaction list/directives, and Beancount
export — not only on the account catalog. Production `INSERT INTO
memory_entries` remains only `memoryApplyRepository`; a new plugin type that
wrote that table directly would bypass ADR 0003.

**Reads are grouped by what kind of data they return, and each kind has one
helper.** A list that answers something the detail page refuses is the defect
this arrangement exists to prevent.

- **Run-derived rows** — Runs, Proposals, Artifacts, `task_runs`,
  `task_evaluations`, Project work events, agent-group messages — go through
  `runReadSql` / `proposalReadSql` / `artifactReadSql` / `runInheritedReadSql`
  in `access/contentAccessSql.ts`. They were in `frontendSupport`, which meant
  every other domain that shows a Run's output wrote the pair itself or forgot
  the Room half.
- **Room transcript** — every reader of `messages` that answers a *person*
  uses `visibleRoomTranscriptSql`, applied unconditionally rather than behind a
  flag a caller could pass `false` to. Agent replay and continuation lookups
  still read the internal rows through `visibleMessagePathSql`, which is the
  point of storing them in order. A domain-event continuation is stored as a
  `user_instruction` so replay sees it in order, and is marked
  `room_display = internal`, so the Room transcript, the pick-by-id surface,
  the context window and the agent-group timeline all leave it out; the group a
  continuation opens is named after the event, not after the machine's own
  prompt.
- **Notes and Knowledge** — one read (the content predicate plus the Phase 2
  access level) and one write check, `assertWritableSpaceObject`: anything but
  `space_shared` belongs to its owner, a Project-bound object also needs writer
  authority in that Project, and a reader served the object at `summary` may not
  replace the body they are not shown. Readable is not writable — a
  `selected_users` grant hands out reading. Every note mutation goes through it:
  update, rollback, delete, placement add and remove, share revoke, tree
  reorder, a notebook-chat edit, and the capture relocation that takes blocks
  out of someone's note. The deleted-note purge deletes only notes its caller
  could have deleted; Space-wide it was one route that destroyed every member's
  wastebasket with no object named in the request.
  Knowledge *items* and *claims* keep their own owner-only mutation rule
  (`canMutateKnowledge`), which is stricter than this one, not looser;
  unifying them would widen who may edit a shared item and is left alone
  deliberately. Free-text search matches a *body*
  only at `full` access; the title stays searchable at every level, because a
  search that still matched a withheld body handed it back a character at a
  time. The retrieval projection carries `owner_user_id`, not whoever created
  the row.
- **Source decision items** — a review action that republishes an item's
  content reads it as the reviewer, and demands full access
  (`sourceItemFullContentReadClause`). A Proposal built from Source material
  takes the narrowest visibility of what it quotes rather than a hard-coded
  `space_shared`, and a briefing's output artifacts go through the Artifact
  predicate.
- **Finance ledger** — `findAccountForViewer` is the one resolver for every
  account id, with a `writable` mode for close and visibility changes; import
  validation loads the ledger *this person* can see, and the server names the
  imported file so the filename filter over validation errors cannot be pointed
  at the stored ledger's own errors. An account this person may not change
  answers "not found", not one of three different 403s.
- **Publications** — a revoked snapshot's `snapshot_hash` is withheld with the
  body it hashes, and an import block names the imported copy only to the person
  who imported it.

**Outbound HTTP to a user-influenced URL.** One boundary,
`@rainver/outbound-guard`, reached from the server through `fetchGuarded`
(`server/src/modules/sources/outboundUrlSafety.ts`). Every Source, Recipe,
Custom Source and manual-URL fetch goes through it — the scan and backfill
paths, the extract/snapshot paths, and the declarative interpreters'
`fetch_page` / `follow_link` / `download_asset` / `paginate` steps.

- Only `http:`/`https:` URLs without embedded credentials.
- The host is resolved and refused when **any** answer is private, loopback,
  link-local (including cloud metadata), unique-local, CGNAT, IPv6 multicast or
  site-local, or one of the IPv6 spellings that carries an IPv4 address inside
  it (IPv4-compatible, NAT64, 6to4, Teredo). It is the same list the host
  daemon's egress proxy blocks, because it is the same module.
- **The connection is pinned to the address that was checked.** The guard hands
  the HTTP client a lookup that answers with that address, so a resolver cannot
  answer public for the check and private for the connect. TLS still validates
  against the hostname.
- Redirects are followed manually and every hop is checked and pinned again.
  A credential — a Source connection's API key header — is sent only while the
  chain is still on the first origin, and an `https` → `http` redirect on a
  credentialed fetch is refused outright. That holds for a credential the
  caller passes as one: `credentialHeaders`, not `headers`. `headers` is sent
  on every hop by definition, so merging a provider key into it defeats both
  rules for any header name outside the three the guard always treats as
  credentials — which is how two preview paths sent a Semantic Scholar or Brave
  key to a redirect target. The port type now carries the field, so a caller
  has somewhere to put it.
- Bodies are read with a byte ceiling and the rest is cancelled; a non-OK or 304
  response's body is not read at all. The whole chain, name resolution included,
  runs under a deadline.
- A blocked address and a name that resolves nowhere answer with the same
  message and the same persisted diagnostics, so the refusal is not an oracle
  for which internal names exist.
- Accepted leftovers. The Open Skill importer
  (`capabilities/skillImporter.ts`) is bounded by a host allowlist rather than
  by this guard: it follows redirects itself and re-checks the final URL after
  the transfer, so a redirect off `raw.githubusercontent.com` would be dialled
  before being refused, and it reads the whole body before applying its own size
  limit rather than reading under a ceiling. The host daemon's egress proxy resolves without a DNS
  timeout of its own; a hung resolver stalls that one CONNECT, which the Run's
  own budget still bounds.
- Provider (ModelProvider) calls are deliberately **outside** this boundary: a
  `base_url` may name a private or loopback address, because a local Ollama is a
  real deployment. Accepted leftover: a member can probe internal addresses
  through the models list and the connection test; responses do not echo
  upstream bodies.

### Deployment and network exposure

- The deployer has host-equivalent authority because it mounts docker.sock. Its Unix
  socket is private to the deployer sidecar and is not an app, agent, evolution,
  code-patch, capability, automation, job, or scheduler surface.
- The sidecar mounts `ops/` read-only and no checkout, and receives only the internal
  token through `.deployer.env`. It is now the **only** holder besides the server:
  the execution-host container used to receive the same token as
  `SANDBOX_RUNNER_TOKEN`, and that stopped when the Runner it authenticated was
  deleted — the daemon holds a bearer token for its own Host row and nothing that
  reaches an internal route. So the integrity of a job's stage events is bounded by
  the deployer's alone: an internal-token holder can claim a queued job or report a
  stage, but only the instance administrator can create one. ADR 0020 §1 chose that reuse deliberately; confirming it is still the
  right trust boundary is an item on the instance-update acceptance in
  [`../tasks/deferred-register.md`](../tasks/deferred-register.md). `RAINVER_ENV_FILE_READONLY=1` makes the shared ops
  library refuse to create or edit the instance `.env` and refuse to regenerate the
  files derived from it. The mode root itself stays writable — the deployer writes the
  pre-migration dump there — so this is a guard on the deployment scripts, not a
  sandbox; docker.sock remains the authority that matters.
- Product deployment routes are instance-admin only
  ([ADR 0020](../decisions/0020-instance-update-through-deployer-pull.md)): creating a
  `deployment_jobs` row is the human approval, and the job's append-only stage events are
  the audit. `/internal/deployment/*` accepts the internal token alone and can report
  stages and claim work, never create it. The server gains no Docker authority under it:
  the pull loop runs in the deployer sidecar, which is the only container that talks to
  docker.sock or a registry.
- The instance must not be exposed directly to the public internet. Production TLS
  termination is a deployment concern. Mutating cookie-authenticated requests refuse
  any explicit `Origin` other than the configured frontend (`FRONTEND_URL`); there
  is no request-derived same-host fallback. Session cookies are always
  `HttpOnly`, `SameSite=Lax`, and `Secure`. The server believes `X-Forwarded-*`
  only from the frontend proxy (`SERVER_TRUSTED_PROXY_HOST`, resolved by name,
  one hop), so `request.ip` is the client that proxy saw; a direct peer such as
  a Run on the built-in host cannot choose it. Pairing-code registration is
  rate-limited per client IP (10 attempts / 10 minutes, persisted under the
  instance cache) — IPv6 by /64, because a /64 is the smallest block an ISP
  hands out and counting whole addresses let one caller take the quota once per
  address. Expired buckets are dropped and the map is capped, so an
  unauthenticated caller cannot grow it, and the window is written out off the
  request's own stack. The pairing code is 13 Crockford base32 characters — 65
  bits — with a ten-minute life, so guessing it is not what the limiter is for.
  The host WebSocket upgrade requires a
  host bearer; a pairing code is not a bearer, and an upgrade without one is
  answered 401.
  The Run tool surface lives at `/api/v1/runs/:runId/tools…`, gated by the Run's
  own bearer token: a paired host's children reach the instance through
  `FRONTEND_URL`, and nginx forwards `/api/` and `/internal/hosts/ws` and
  nothing else. The dev Vite proxy forwards that one WebSocket path rather than
  all of `/internal`, so dev exposes exactly what production does.
  A GET whose effects reach past its response — the host and subscription login
  streams, which start a vendor login on the owner's machine, and the four
  Project Folder reads, which spawn `git` there and write a policy-audit row
  naming the requested path — goes through `stateChangingReadAllowed`. It reads
  three terms **in order**, and **fails closed**. An explicit `Origin` decides
  it, judged against `FRONTEND_URL`: that is the browser naming who caused the
  request, and it comes first so that a frontend served from a sibling host of
  the API still works. With no `Origin`, `Sec-Fetch-Site` is what is left, and
  only `same-origin` or `none` — the person's own address bar — is accepted;
  `same-site` is not, because a top-level navigation from any host under the
  same registrable domain sends exactly that, with no `Origin` and with the
  `SameSite=Lax` cookie attached. And a request carrying neither header, and
  none of this client's own, is refused rather than allowed — a top-level
  cross-site navigation from a browser that sends no fetch metadata carries no
  `Origin` either, and allowing that case was the hole. `SameSite=Lax` sends the cookie on a
  top-level cross-site GET, so these needed the check a POST gets for free. A
  route whose only effect is its response must not use it: the host usage route
  is a cache read of `host_runtime_usage` — the probe is the POST beside it —
  and guarding it would refuse an ordinary cross-origin read for nothing. The OAuth pair,
  `GET /api/v1/auth/google` and its callback, creates a session by design and is
  protected by its own state cookie instead. It is **not** the only GET left
  that writes: a detail read records a `content_access_logs` row, `GET
  /api/v1/memory/:memoryId` bumps `access_count` and `last_accessed_at`, the
  information-digest reads rebuild their own rows, and a few others ensure a
  draft or an id on first read. Those are recorded rather than guarded — each
  needs a resource id the caller already knows, and the writes are the read's
  own bookkeeping — with one consequence worth stating: an attacker who knows a
  memory id can drive a forced read from another site, which both delays that
  memory's demotion and writes an access-log row naming the victim as reader. A cookie-authenticated **write** takes a
  `Sec-Fetch-Site` term beside its `Origin` check too, but a weaker one: it
  refuses an explicit cross-site value and otherwise allows, including a
  request carrying neither header, because a non-browser caller — a host
  daemon, the Run CLI — sends neither and `SameSite=Lax` covers the browser.
  The read check has no such fallback available, so it fails closed. Requiring `application/json`
  on writes was considered and not adopted: the property it buys is what
  `Sec-Fetch-Site` already decides, and the activity import route takes a real
  `multipart/form-data` upload, so the rule would need an exception for the one
  route most worth guarding. General CSRF-token hardening is not implemented.

Every `/api/` response carries `Cache-Control: no-store, no-cache,
must-revalidate, private` — from one `onSend` hook, and from
`sseResponseHeaders` for the three event streams that write their own header
block with `reply.raw.writeHead` — flushed to the socket before any hook could
set a header, whether or not the route also hijacks the reply (one of the three
does). Those had each hand-written `no-cache`, which forbids reuse without
revalidation but permits a shared cache to *store* the body; one of them
carries live conversation turns. They add `no-transform`, which matters only on
a stream: an intermediary that re-buffers the response holds every event until
it ends — the surface is somebody's
private content answered against their session cookie, and a route that forgot
the header would be invisible. It is set in Fastify rather than with an nginx
`add_header` on the API location, because nginx *replaces* the inherited
`add_header` set in any location that uses one, so setting it there would
silently drop every security header from API responses.

The production frontend nginx sends `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Cross-Origin-Opener-Policy: same-origin`, a
`Permissions-Policy` that denies the device APIs the app does not use — with
`microphone=(self)`, which voice capture on the Capture page needs and which
denying would have broken in production only — and a same-origin CSP — defined **once** in `apps/web/security-headers.conf` and
`include`d by every location that sets a header of its own, because five
hand-maintained copies is how one of them came to disagree with the others.
`img-src` allows `https:`, and that is deliberate: the Library reader renders a
captured article with the article's own remote images
(`image_policy: "remote_reference"`), so this header cannot be the layer that
stops a model-named one. Tightening it broke every captured article's images,
and only in production, since dev serves no headers — the same split the theme
script was moved out of `index.html` to close. The **renderer** is the boundary
instead: chat markdown and every model-authored document render a cross-origin
image as a link and never fetch it, and the reading core's `remoteImages` is off
unless a caller opts in, which only the captured-article surface does. `http:`
stays out, as does every bare scheme on every other directive. Getting the
second layer back for images needs a trusted image-host allowlist, which O3
defers until there is a real need. `style-src` still allows inline styles — the
UI library writes them, and a nonce needs a request context a static file
server does not have. The theme script that runs before first paint is a file
rather than inline, because `script-src 'self'` blocked it: it silently did
nothing in production and worked in dev, where Vite serves no CSP. The desktop
(Tauri) shell has a policy set rather than `csp: null`; it is close to this one
and **unverified** — the shell is an unbuilt scaffold (ADR 0005), its webview
origin is not the instance, and nobody has run it against a control plane.

**No model-authored text loads an external image** (D5). One
`safeStreamdownProps` config is spread by every renderer, and it holds three
defences, because no one of them covers the whole surface:

- its `img` component renders a cross-origin source as an ordinary link —
  domain visible, full URL on hover, new tab — instead of an `<img>`.
  Click-to-load was rejected: the click sends the same URL, so it only turns
  zero-click into one-click;
- `urlTransform` blanks a `src` that is neither same-origin nor `http(s)`. It
  is called only for the keys in `html-url-attributes`, which is why it cannot
  be the whole answer;
- the **sanitize schema** drops `<source>`. `<picture>` resolves to its first
  matching `<source>`, so an external `srcset` there fetches with no click —
  and the same-origin `<img>` the component renders is what activates it, since
  a `<picture>` with no `<img>` fetches nothing. `srcSet` is not a key
  `urlTransform` sees and `components` governs only elements we name, so
  neither of the other two defences reaches it.

Streamdown's default pipeline *is* `rehype-raw` → `rehype-sanitize` →
`rehype-harden`, so model-written HTML is parsed into real elements and a raw
`<img>` arrives at the same component as a markdown one. `skipHtml` does **not**
help: it visits `raw` nodes after the unified run and `rehype-raw` has already
consumed them, so it finds none and silently does nothing — the prop was
removed rather than trusted. What stands between model-written HTML and the DOM
is the sanitize schema, which is why tightening it is the fix above and not a
precaution. An image the instance serves itself still renders inline.

The same rule reaches the *other* renderer. A Library summary or digest is
written by a Run over ingested third-party items and is displayed through the
Tiptap reading core, not through Streamdown — so that core takes the decision
too, as an explicit `remoteImages` flag that is off unless the caller says
otherwise. One renderer with one answer for both kinds of document was how a
digest could be induced to fetch from a host the model named.

The flag is passed down rather than decided at the workspace, because
`ReaderWorkspace` renders more than one kind of document too: a captured
article, whose images are part of what the person chose to read, and a research
report, which a synthesis Run wrote over the same ingested items. Only the
captured-article page opts in. Deciding it one level up would have given both
the same answer, and the report's projection emitting no image nodes today is
not a property worth resting on.

Two differences worth stating rather than discovering. An external *link* in
chat goes through Streamdown's confirmation modal; the link a blocked image
degrades to does not, because it is our own anchor — it is one click, against
two, and it carries more information than a text link does (the domain in the
text, the full URL in the tooltip). And a blocked image does not always reach
that link: a `data:` source, or one carrying embedded credentials, renders as
nothing at all, and a source `rehype-harden` rejects first gets its own
placeholder. D5's promise holds for the ordinary case.

The PWA service worker must not cache authenticated `GET /api/v1/*` bodies; the
app deletes that cache unconditionally at boot as well as on logout and on a
401, because a cache written by an older build outlives the code that stopped
writing it. Logout clears local and session storage against a list of what to
**keep**, not what to delete — a delete-list retained every new content key
until somebody remembered to add its prefix — and announces itself to this
browser's other tabs, which would otherwise keep a rendered page full of the
previous person's content. A 401 announces the same way, since a session
revoked server-side otherwise reaches only the tab that happened to ask. The
keep-list holds appearance and layout only; one entry, `rainver:scene-collapsed`,
is a map keyed by scene id, which is safe while scene ids come from the static
module registry and would not be if one ever became a Space or Project id.
Clearing is deliberately lossy in the harmless direction: a person's Context
Ops explain presets go with it. The browser treats server-authored in-app hrefs as
same-origin paths only, resolved through `URL` rather than judged as text:
`/..//evil.example` passes every textual rule and the browser then collapses it
to `//evil.example`. The same rule decides the OAuth `next` parameter
server-side. Avatar images accept `http(s)` and refuse `data:`.

### What a spawned process inherits, and what is written down about it

- **One environment builder per kind of spawn.** A Run gets either the ambient
  allowlist (`filterAmbientEnv`, for a bound or strict Run, where the container
  contributes nothing) or the machine's environment minus the vendor
  credentials (`clearVendorCredentialEnv`, for a host-login Run on the owner's
  own machine, which needs its PATH, git and ssh configuration — dropping those
  would take real things away from the runs this branch exists for). Every
  helper the daemon spawns *that runs a vendor runtime* — an adapter installer,
  the `--version` and `login --help` probes, the Codex usage probe, an ACP
  `session/list` — goes through `helperProcessEnv`, the same credential-cleared
  rule. Each of those used to spread `process.env` whole, or delete two named
  keys beside it. `keepStateRoots` is the one exception, for a helper that reads
  the machine's *own* history: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` name where
  state lives, not a credential, and clearing them by prefix sent
  `session/list` to the default location and reported the machine as empty. The
  daemon's non-vendor spawns — `git`, `systemctl`, the installer shell script a
  person typed — take the machine's environment as it is: fixed arguments,
  trusted binaries, and nothing that echoes an environment back.
- **The daemon refuses a redirect** on every call that carries a credential:
  the control-plane calls, each carrying this host's bearer token — registration
  exchanges a pairing code for a long-lived one — and the Claude usage probe,
  which carries the owner's OAuth access token. The one deliberate exception is
  the adapter *download*: an archive comes from a third-party publisher through
  the ACP registry, and a GitHub release asset always 302s to
  `objects.githubusercontent.com`, so refusing would break the ordinary case.
  Nothing of ours travels with it, and the https requirement is re-applied to
  where the download actually landed. Its config's `server_url` is re-checked on
  read, not only at pairing time — plain HTTP only for an address that is this
  machine. "This machine" is judged as an address: `startsWith("127.")` was true
  of `127.evil.com`. The built-in host is exempt, because it adopts a credential
  the instance published to it over the Compose network, where the control plane
  is `http://server:8010` and there is no pairing at all; the exemption is
  decided by an environment variable set only inside that container, not by the
  config's own `trust` field, which lives in the file the check distrusts.
- **Codex's strict-host sandbox rewrite** sets the *top-level* `sandbox_mode`
  and writes only inside the Run's own profile directory — the Agent × container
  profile, never the installation's login home, which every Agent on the host
  shares. TOML scopes a key to the table above it, so matching `sandbox_mode`
  anywhere rewrote the first named profile's key instead — leaving the default
  the Run actually reads untouched, and quietly changing a profile configured
  for something else. Recognising where the top-level table ends took three
  conjuncts, each added after the previous one was found insufficient: a table
  header is a bracketed name **alone on its line** (a bare leading `[` also
  matched a multi-line array's continuation), **at bracket depth zero** (a final
  array element carries no trailing comma and so reads exactly like a header),
  counted over the line with **strings and comments removed** (one unbalanced
  `[` inside either pinned the depth and disabled the scan entirely). The scan
  for an existing key carries the same string-awareness, or a `sandbox_mode`
  line inside a multi-line string is rewritten instead of the real one — which
  leaves Codex starting cleanly and the Run silently unable to write.
- **Evidence and audit redaction.** One module (`runs/evidenceRedaction.ts`)
  decides what a secret looks like in free text. It covers what
  `\b(token|secret)` could not — `\b` does not fire between `_` and a letter,
  so `access_token=`, `refresh_token=`, `id_token=` and `client_secret=` all
  went through — plus quoted JSON keys, a bare `?key=`, `AIza…`, GitHub tokens,
  JWTs and `Basic`. A value that is one of the words a process uses to say a
  credential is *absent* is deliberately left alone: redacting `secret: absent`
  hides the answer and protects nothing. The pattern that keys on a *name* is
  anchored rather than led by an unbounded quantifier: a greedy `[\w.-]*` in
  front of the alternation made the scan quadratic, and a member-authored Custom
  Source handler that logged 64 KiB on one line held the event loop for eight
  seconds. The anchoring is what protects the unbounded callers —
  `redactSecretPatterns` is handed a Custom Source handler's whole log, and a
  5xx provider body, with no ceiling of its own. `redactEvidenceText`, which
  persists, additionally truncates before it scans, reading a little past the
  cut so a credential straddling it is still matched whole rather than left as
  a head too short to recognise.
- **The policy audit sanitizer** (`policy/sanitizer.ts`) is a different
  mechanism on different input — decision metadata, not request logs — and it
  matches key names by case-insensitive *substring*, so `api-key` covers
  `x-goog-api-key`. Bare `authorization` is deliberately **not** on its list:
  substring-matched inside the policy module, which is about authorization, it
  would redact `authorization_request_id` and every other field that links an
  audit row to its decision. `proxy-authorization` is covered where it actually
  arrives — the request-log redact paths above.

### A Run's network reach on the built-in host

Three profiles, stated by the dispatch and applied by the daemon:

| Profile | What it means |
| --- | --- |
| `none` | No network. The namespace is unshared, so this is the only one that **confines**. |
| `default` | The general web, git and the vendor a subscription belongs to, through the host's egress proxy. Package registries are refused with a reason the runtime prints. |
| `install` | `default` plus package registries. Comes only from the dispatch, which the server composes; a standing grant on the Agent runtime profile is refused, because writing one takes only read access to an ordinary Agent. No product surface grants it yet (deferred register). |

**`default` and `install` are policy and a record, not containment.** The
container reaches the Internet over its own bridge, and a strict namespace
without `--unshare-net` keeps that network; `HTTP_PROXY` *points* a Run at the
proxy, and every vendor CLI, git and package manager follows it. A process that
deliberately opens its own socket does not. Do not read the refusal of a
package registry as a guarantee that a Run cannot fetch one — read it as the
policy a cooperating runtime is held to, plus a per-Run record of what it
reached, reported on the Run's events.

**One part of it does hold regardless.** The proxy refuses any address inside
this instance's own network — RFC 1918, loopback, link-local, unique-local,
carrier-grade NAT, and the cloud metadata endpoint — under every profile,
`install` included, and it checks the *resolved* address rather than the name,
so a public name pointing at a private address is refused too. That is the
proxy declining rather than the client neglecting to ask, so it is a boundary
against a Run reaching the database, a sibling container, or instance
credentials. It is not a boundary against a Run that bypasses the proxy
entirely, which the `host-egress` bridge still permits; making it one needs a
userspace network helper under `--unshare-net`, recorded in the deferred
register.

The 2026-09-10 backend security review sequence covered credential egress,
the memory/proposal write gate, isolation-exception read residue, unattended
credential spend, and persistence / extract / plugin / deployer paths. The
sequencing plan is retired; git history holds it. Accepted leftovers from
that sequence stay accepted: pairing-code display, Origin + `SameSite=Lax`
CSRF without a token, CSP `style-src 'unsafe-inline'`, invite tokens in URLs,
proxy leases not pinning model/path (ADR 0008), the on-disk master key,
revoke-after-lease host files, a new plugin type inserting `memory_entries`
directly, finance `validate` error text that may name a hidden account,
workflow node Runs using `trigger_origin = job` (fail-closed), and deployer
internal-token reuse for stage events (ADR 0020; deferred-register
acceptance).

The 2026-09-11 unreviewed-surfaces sequence reviewed context injection,
Knowledge/Notes/Reader/Capture, membership, notifications/backup, and Sources
extract. It closed `research_notebook` note ACL, Knowledge/Notes `summary`
body withholding, retrieval `context_taint` owner attribution, and
post-processing decision item ACL. The sequencing plan is retired; git
history holds it. Accepted leftovers from that sequence stay accepted:
memory-maintenance scans still exclude only `highly_restricted` (ordinary
`private` may appear in an owner-private report); Room rolling-summary
workers do not receive structured `external_untrusted` (attach-time fence
prose remains inside copied content); `recordDetailRead` is not on every
detail surface; there is no Space leave/remove API (orphan private rows
after a membership ends remain); Source `GET /jobs` and
`GET /evidence-links` are Space-scoped metadata.

The 2026-09-11 skipped-surfaces sequence closed Agent version GET/restore
ACL (same content gate as `GET /agents/:id`; restore is owner-only for an
owned Agent), Activity/Artifact/Run-turn `/io` `summary` body withholding,
`code_patch` rollback using the same `proposal.apply` and
`project_folder.write_patch` gates as accept, and stale `cancelling` recovery
settling as `cancelled` rather than a retryable `orphaned`. The sequencing
plan is retired; git history holds it. Accepted leftovers from that sequence
stay accepted: Dev Vite bind-all (token still required); Reader artifact
omitting `roomRunReadAccessSql`; `code_patch` payload bytes that live remote
browse would refuse; Learning Space-global `project_id IS NULL` visibility;
Home summary counts as Space-wide oracles.

The 2026-09-11 security remediation sequence fixed the findings of the three
reviews above by mechanism rather than by patch: one summary-withholding type,
one authorizer per kind of shared command, one credential-spend authorizer, one
persona-write rule, one outbound HTTP guard, one read predicate per data class,
one spawn-environment builder, and one place that decides what a browser may
fetch and keep. The plan is retired; git history holds it, and each phase's
commit message states what it changed and why.

It closed three of the leftovers listed above. The dev Vite `/internal` proxy
now forwards only `/internal/hosts/ws`, which is what production nginx forwards,
so dev no longer exposes routes production does not. Cookie-authenticated
writes, and the GETs whose effects reach past their response, now take a
`Sec-Fetch-Site` term beside the `Origin` check. And chat markdown no longer
loads an external image at all.

Accepted leftovers from this sequence: CSP `style-src 'unsafe-inline'` stays,
because the UI library writes inline styles and a nonce needs a request context
a static file server does not have. CSRF is still Origin plus `Sec-Fetch-Site`
plus `SameSite=Lax`, with no token. A ModelProvider `base_url` may still name a
private address (D2). An external *link* in chat can still carry data in its URL
when a person clicks it — rendering cannot close that, because the root is
prompt injection into the model's output, and the link is shown with its
confirmation step rather than removed; external *images* no longer load on their
own (D5). A trusted image-host allowlist is deferred (O3) until a real need
appears — and it is now the thing that would let `img-src` drop `https:` again.

Two more, found by the integration review and recorded rather than fixed, both
outside what this plan set out to do. **Knowledge body search has a hit/miss
oracle through the retrieval index**: `bodyMatchSql` gates an `ILIKE` on `full`
access, but the sibling `retrieval_chunks` search matches `tsv`/`plain_text`
with no viewer term, and although revalidation redacts the returned text, the
row still comes back as a hit — so a summary-level reader can probe candidate
substrings and reconstruct a withheld body a piece at a time. Closing it means
giving that search a viewer predicate, which is a design change to the retrieval
module. **The Open Skill importer reads a response body with no ceiling**
(`capabilities/skillImporter.ts`): `await response.text()` runs before the byte
limit is checked, across up to 200 package files, so a member pointing it at
large files in a repository they control can exhaust server memory. It is
bounded by a host allowlist, which is why it was left outside the outbound guard
— but the body half needs no redirect and no cooperation from the host. The finance plugin's transaction create is not atomic, which needs a
transaction port on `PluginHostContext`. And `completeTask` judges completion in
the asking person's view while settlement judges the same Task unscoped, so an
Agent can be refused a close that settlement then accepts — each half is right
on its own.

---

## 11. Dogfooding Readiness

| Use case | Status |
|---|---|
| Personal dogfooding (single user per space) | **Ready** |
| Family / shared-space dogfooding | **Ready** |
| Internal team / workspace dogfooding | **Ready** |

All durable-data API routes are authenticated and space-scoped. Session conversation history
is protected by auth + space + user scoping. Activity → proposal → memory boundary is
enforced. Project Folder path traversal is blocked. Artifact export is space- and
visibility-gated. Credential secrets are not exposed in API responses. Egress approval for
personal memory is enforced and tested.

Test coverage: 4248 server tests across 435 files, plus 915 in the web client
(unit / contracts / invariants / workflows). A count goes stale the week it is
written; what it is here for is the order of magnitude and the fact that the
durable-behaviour tests run against real PostgreSQL rather than a fake.

---

## See Also

- `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` — canonical stable policy reference
- `docs/PERSONAL_MEMORY_GRANT.md` — personal memory grant lifecycle
- `docs/THREAT_MODEL.md` — threat model
- `.agent/architecture/POLICY_ENFORCEMENT_INVENTORY.md` — per-domain enforcement status
  and PersonalMemoryGrant implementation detail
- `docs/TARGET_VIEW_MODEL.md` — ExecutionContext and cross-space aggregation design
