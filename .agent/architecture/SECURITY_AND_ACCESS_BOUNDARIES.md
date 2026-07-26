# Security and Access Boundaries

This document records the durable access control principles for the agent-space backend.
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
- `GET /providers/litellm-providers`, `/providers/catalog`

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
private content into that space-wide artifact. Retrieval and per-run context
injection do inherit oversight by design (an admin-initiated run may compile
other members' otherwise-private content into that run's own context/output,
scoped to that run), which is a deliberate consequence of the same
canonical-predicate mechanism, not a separate feature.

Oversight does not pierce project_folder/project scope gates, source consent
gates, or any other post-visibility deny gate besides the `highly_restricted`
exception above. Cross-space reads always fail regardless of oversight;
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

**Runtime:** project-scoped memory is cut before runtime/chat prompt assembly.
The per-run `ContextBuilder` retriever enforces the project cut (a run bound to
project P injects P's memory only if `instructed_by_user_id` can access P, plus
project-free memory; a no-project run injects project-free memory only). Chat /
assistant context candidates apply the same project-membership ACL after
`canReadMemory`, so concrete project memory is only available for projects the
viewer can access. Shared `ContextDigest` generation and consumption exclude
`project_id IS NOT NULL` memory; project memory only flows through gateable
per-run/chat retrieval. Memory retrieval search is current-space only;
cross-space memory retrieval is not implemented.

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

**Project Folder file access** (`server/src/modules/projectFolders/repository.ts`):
- `PathPolicy` (`server/src/modules/projectFolders/pathPolicy.ts`) is enforced before any disk access.
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
