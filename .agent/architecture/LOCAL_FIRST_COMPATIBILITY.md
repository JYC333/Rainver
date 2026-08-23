# Local-First Compatibility Architecture Note

**Status:** Durable design position — not a planned sprint  
**Scope:** What agent-space must preserve to remain compatible with future partial local-first clients

---

## 1. Product Stance

agent-space is **not** a local-first system and will not become one. The server-authoritative model is a deliberate design choice: the control plane holds canonical state, memory is managed through a proposal workflow, and policy and credentials require central enforcement.

The compatible goal is narrower: **local-first personal interfaces for capture, drafts, tasks, cards, lightweight notes, and offline reading** — where local-first genuinely improves user experience — while keeping active memory, proposals, credentials, policy, and deployment firmly server-authoritative.

**Amended 2026-08-21 ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):** agent execution and Project Folder operations are authoritative to whichever **execution host** owns the folder, not necessarily the server process — the server host (unchanged, strictly isolated) or a personal machine the user has explicitly paired as a trusted execution host. This is a narrowing, not a reversal: an execution host is a machine the user owns and has paired with the control plane, never an arbitrary or untrusted client, and it never gains the ability to originate syncable drafts the way the local-first clients in §2 do. The "not local-first" stance in this document is entirely about client-originated sync of drafts/records, and is unaffected by where a paired execution host happens to run an agent.

Key principle: any object that feeds into durable system state must pass through the server. Local-first is a client convenience layer, not a durability layer.

---

## 2. Data Classification

### Syncable / Likely Syncable
Objects that can originate client-side and sync to the server:

| Object | Notes |
|---|---|
| Activity drafts | Pre-submission captures; become ActivityRecord after server accept |
| Tasks | Last-write-wins acceptable initially; status/visibility changes need care |
| Habit / check-in records | Low-conflict, append-friendly |
| Card review state | Client-authoritative until server persists |
| Knowledge / note drafts | User resolves conflicts if diverged |
| Decision drafts | Becomes server record on submit |
| User preferences | Low-conflict; server is source of truth on conflict |

### Server-Authoritative
Objects that may have a client draft phase but whose accepted/published state lives on the server:

- ActivityRecord (accepted by server)
- Published KnowledgeItem
- Active Memory
- Proposal
- ProposalApply
- Run
- RunStep
- Artifact (source of truth)
- AgentVersion (where it references runtime / provider / policy)
- Policy

### Server-Only
Objects that must never leave the server boundary:

- Credentials and provider secrets
- RuntimeAdapter secrets / config
- Project Folder filesystem paths (server-host rows only — see below)
- Sandbox paths
- Deployment jobs
- Capability install / update state

**Amended 2026-08-21 ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):**
for a Project Folder row bound to a remote execution host, there is no
server-side path to keep server-only — the control plane never possesses
one. Only a daemon-reported `display_path` (UI-display data, never an access
or identity key) is stored. "Server-only" for that row means "never treated
as control-plane authority", which the daemon path already satisfies by
construction rather than by boundary enforcement.

### Cache-Only
Read-only local copies; never written back as truth:

- Recent timeline cache
- Artifact preview cache
- Run log cache
- Published knowledge read cache

---

## 3. New Syncable Table Guidelines

Any future table designed to participate in sync should prefer these columns:

```
id                        -- stable UUID
space_id                  -- where applicable
owner_user_id             -- where applicable
created_at
updated_at
deleted_at                -- soft delete; clients respect tombstones
version / revision        -- monotonically increasing; used for conflict detection
last_modified_by_user_id
last_modified_by_device_id
sync_origin / client_origin  -- which device/client last wrote
conflict_state            -- only when the object type needs explicit conflict tracking
```

Tables that are server-authoritative or server-only do not need `device_id` or `sync_origin` columns.

---

## 4. Offline Write Rules

### Offline clients may create locally:
- Captures (become ActivityDraft or Activity on sync)
- Drafts (task, knowledge, decision, note)
- Task edits (title, description, local status)
- Card reviews
- Local notes

### Offline clients must not directly apply:
- Active memory writes
- Proposal acceptance or rejection
- Policy changes
- Credential changes
- Project Folder file changes
- Code patch apply
- Deployment actions
- Capability install or update

The reason is not technical complexity — it is that these operations have side effects that require server-side validation, authorization, and sequencing. Allowing offline apply would create a shadow execution path that bypasses policy enforcement.

---

## 5. Activity and Memory Boundary

Offline capture must become **Activity** or **ActivityDraft** — not active Memory.

The path is:

```
offline capture → ActivityDraft → sync → ActivityRecord (server-accepted)
                                       → [optional] Reflector → Proposal → ProposalApply → Memory
```

Raw offline input must not become active Memory directly, even when the content is clearly factual. The proposal workflow exists to enforce quality, context, and authorization checks that cannot run offline.

---

## 6. Proposal Boundary

Future clients may prepare **ProposalDraft** objects locally (e.g., a user editing a knowledge suggestion). The flow must remain:

```
ProposalDraft (client) → submit → server validates → real Proposal created
                                                    → server applies → Memory / KnowledgeItem updated
```

Clients must not skip the server acceptance step, even if they have a cached copy of the target memory. ProposalApply is always server-authoritative.

---

## 7. Agent Execution Boundary

Clients may:
- Request agent runs
- Cache run status, logs, and artifact previews locally
- Display streamed output

Clients must not:
- Execute agent logic locally and treat the result as durable truth
- Apply agent-produced memory writes without the server proposal flow
- Independently resolve artifact references against local state

Agent execution remains server-side on the server host. **Amended 2026-08-21 ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):** it is control-plane-side on a remote execution host — a personal machine the user has paired, not a client. Tool use, memory access, credential injection, and policy checks are server responsibilities on the server host; a remote trusted host deliberately does not receive server-brokered credentials, in-process tool calls, or PathPolicy enforcement (see §1's amendment above and [SECURITY_AND_ACCESS_BOUNDARIES.md](SECURITY_AND_ACCESS_BOUNDARIES.md) §10) — it runs the machine's own already-installed CLI under its own login state. What remains non-negotiable is that a *client* (browser, mobile) never executes agent logic or holds credentials; that boundary is unchanged.

---

## 8. Conflict Strategy

| Object type | Strategy |
|---|---|
| Personal captures | Append-only; conflicts are rare and low-stakes |
| Tasks | Last-write-wins acceptable initially; visibility and status changes require careful merge or user prompt |
| Drafts (knowledge, decision, note) | User-resolved conflict if diverged; present a diff |
| Active memory / proposal apply / policy / Project Folder | No offline apply; queue and submit when online |

Do not prematurely introduce CRDT or operational transform. The current user scale and sync surface do not justify the complexity. Start with version-based conflict detection and user-prompted resolution where needed.

---

## 9. Do Not Build Now

The following are explicitly out of scope for this system:

- **CRDT** — premature for current scale and object types
- **Full event sourcing** — not the current storage model; adding it retroactively is high risk
- **Full offline agent execution** — violates policy enforcement and memory authority boundaries
- **Full mobile database sync** — no current mobile client; design when the need is concrete
- **E2EE / zero-knowledge architecture** — incompatible with control-plane-mediated memory management, and (per [ADR 0016](../decisions/0016-control-plane-execution-hosts.md)) still incompatible on a paired execution host: pairing extends trust to a specific machine, it does not make that machine zero-knowledge to the control plane
- **Project Folder file local-first sync** — filesystem paths are server-authoritative; local sync introduces conflict resolution complexity that has no current payoff

These may become relevant in future iterations, but should not influence current implementation decisions.

---

## 10. Practical Next Step

The current priority remains dogfooding the server-authoritative loop:

```
capture → ActivityRecord → Run / Proposal → review → Memory / Task
```

Local-first compatibility is a **preservation constraint** on schema and API design — not a feature to build. When adding new syncable objects, apply the column guidelines in section 3. When adding server-authoritative objects, ensure they are not inadvertently exposed to offline mutation paths.

No local-first infrastructure should be built until at least one concrete client use case (mobile capture, offline task editing) is ready to ship. Design for compatibility; implement on demand.
