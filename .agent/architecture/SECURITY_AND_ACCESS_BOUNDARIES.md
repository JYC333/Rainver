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
- `GET /jobs/handlers`
- `GET /runtime-tools...`, `POST /runtime-tools/{runtime}/install`, `POST /runtime-tools/{runtime}/activate`
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
grantees. `access_level=summary` withholds full content from non-owners. Project Folder
and project scope are independent from visibility. Space owner/admin roles may
manage access policy but do not bypass read policy **by default**; the single
exception is the creation-time, immutable Space oversight mode (below), scoped
to reads within that Space.

Every persisted context-snapshot item records the source content's owner and
visibility. The Run aggregates those rows into `context_taint_json`: the
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
Artifact lists (`frontendSupport`'s `runReadSql`, `proposalReadSql`,
`artifactReadSql`); the Project Pulse in-progress count; and the canonical
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
`listTaskRuns`, `listTaskArtifacts` and `listTaskProposals` sit behind a
content predicate on the Task with no Room term — no path writes a Room-scoped
Run into `task_runs` today, so those are latent rather than live, and they are
where to look first if one ever does. The Board read model's run and output
columns (`boardReadModel.ts`, through `task_runs` / `task_artifacts`) are the
same latent class. `listPolicyDecisionRecordIdsForGroup` carries no viewer
predicate at all and rests entirely on its parent. The daily-report artifact
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
immutable snapshot hash and creates a new private target-Space resource. Revocation
blocks future imports without deleting existing copies.

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

- Provider API responses explicitly exclude `api_key`. The internal provider
  invocation target (which carries the decrypted key) must not be exposed
  outside the service/adapter layer.
- Provider and CLI credentials are user-owned resources. Active-space use is
  controlled by explicit grant rows; ungranted use fails before secret/profile
  resolution.
- CLI runtime tool installs are instance state, not user or space secrets.
  `INSTANCE_ADMIN_EMAIL` gates install/activate mutations. Space owners/admins
  can only enable/disable and select allowed/default installed versions for
  their own space.
- Provider edit/key replacement and CLI login/profile mutation are owner-only.
  Login PTY input is resolved through the authenticated owner's profile before
  it can reach an active runtime session; a profile id alone grants no access.
  Space owners/admins may disable grants for their space without reading or
  editing secret material.
- CLI credentials are stored as filesystem-managed paths; no secret material appears in API
  responses or SSE event streams. The secret-free `available` endpoint omits
  `source_path`.
- `AgentVersionOut`, `RunOut`, and `ArtifactOut` schemas contain no credential fields.
- Run trace exposes AgentVersion system prompt presence/hash metadata only; it
  does not inline raw system prompt text, raw rendered context text, or artifact
  content.
- Agent/run/artifact/proposal outputs must not expose secret material.

---

## 10. Project Folder and Artifact Path Safety

**Scope note (amended 2026-08-21, [ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):**
everything in this section describes the **server host** only. A Project
Folder row bound to a remote (personal) execution host never reaches this
code path at all: the control plane holds no path for it, PathPolicy is
not invoked on the server and there is no bubblewrap namespace — the remote
daemon spawns Runs natively on the machine's own filesystem under trusted-host
mode (B62). For Files & Code browse reads, the daemon runs the same shared
`@rainver/folder-read` PathPolicy and byte/file-count limits before returning
data over the `folder_read` channel. This is a narrower trust model for
execution hosts the user owns and has paired, not a relaxation of these
invariants for the server host.

**Project Folder file access** (`server/src/modules/projectFolders/repository.ts`):
- A registered Project Folder is one shared workspace with no personal area.
  Its whole root is available to Project-authorized readers and mounted
  read-only into CLI sandboxes; personal material belongs in database-backed
  personal content. File-level ACLs are intentionally not a second source of
  truth for an externally mutable filesystem.
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
- Low/medium-risk local CLI execution uses a rootless bubblewrap namespace:
  an empty filesystem view receives only system runtime trees, exact
  DNS/NSS/linker/CA configuration paths (never the whole `/etc`), runtime
  tools, registered Folder entries, generated context, brokered HOME, and Run
  Exchange paths. Folder/context mounts are read-only and the view root is
  remounted read-only; other spaces and host paths are absent. Only brokered
  HOME and Run Exchange output paths under configured managed roots are
  writable. Namespace preflight failure is fail-closed.

**Artifact export** (`server/src/modules/artifacts/` and run artifact materialization):
- paths escaping the artifact storage root return no file.
- Paths resolving into sandbox roots are rejected.
- Artifact read checks verify space and visibility before a stored file is resolved.

### Deployment and network exposure

- The deployer has host-equivalent authority because it mounts docker.sock and the
  repository read-write. Its Unix socket is private to the deployer sidecar and is not an
  app, agent, evolution, code-patch, capability, automation, job, or scheduler surface.
- Product deployment routes currently fail closed with 501. A future trigger must verify
  human approval in the server authority and persist durable audit state before submission.
- The instance must not be exposed directly to the public internet. Production TLS
  termination, rate limiting, and general CSRF-token hardening are not implemented.

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

Test coverage: 1127 passing tests (unit / contracts / invariants / workflows).

---

## See Also

- `docs/POLICY_AND_PRIVACY_BOUNDARIES.md` — canonical stable policy reference
- `docs/PERSONAL_MEMORY_GRANT.md` — personal memory grant lifecycle
- `docs/THREAT_MODEL.md` — threat model
- `.agent/architecture/POLICY_ENFORCEMENT_INVENTORY.md` — per-domain enforcement status
  and PersonalMemoryGrant implementation detail
- `docs/TARGET_VIEW_MODEL.md` — ExecutionContext and cross-space aggregation design
