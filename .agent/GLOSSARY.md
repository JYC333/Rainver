# Glossary

Key terms used consistently across rainver. Implementation facts come from
schema, protocol, and `server/src/`. Unimplemented product words are not
defined here; see
[plans/unimplemented-from-guides.md](plans/unimplemented-from-guides.md).

---

**Deployment Instance**
One running installation (one server, one database). Hosts many spaces.
Runtime data lives under `RAINVER_ROOT` / `RAINVER_HOME` (default host
parent `~/.rainver-data`).

**Space**
Product-level isolation boundary. Personal, household, or team. All data
scoped by `space_id`.

**User**
A human person. Referenced by `user_id` across the schema. Can belong to
multiple spaces.

**Agent**
An AI runtime actor, separate from User. Identity and visibility live on
`agents`. Versioned configuration (model provider FK, JSON policy/config
blobs) lives on `agent_versions`. `agents.current_version_id` points at
the active version.

**Run**
The central execution object. A single agent invocation scoped to a
Space, and optionally a Session, Project, Folder, or Job.

`Run.status` (`packages/protocol/src/runOrchestration.ts`):
`queued | running | cancelling | succeeded | failed | degraded |
cancelled | orphaned | waiting_for_review | waiting_for_dependency`

`Run.mode`: `live` | `dry_run`

A Run can produce Activities, Artifacts, and Proposals.

**Activity**
Raw input or event (`activity_records`). `source_kind` when set is one of
`user_capture`, `chat_message`, `external_chat`, `file_import`,
`web_capture`, `run_event`, `project_folder_event`, `system_event`,
`external_source`, `source`. Never becomes active memory directly —
flows through proposals first. `server/src/modules/activity/`.

**Artifact**
Persistent output of a run. Stored under `ARTIFACT_STORAGE_ROOT` (default
`$RAINVER_HOME/storage/artifacts`). Export:
`GET /api/v1/artifacts/{id}/export`.

**Proposal**
Pending change awaiting human approval. Product-recognized types are
listed in [architecture/PROPOSALS.md](architecture/PROPOSALS.md).
Unregistered types fail closed on accept.

**Runtime Context Gateway**
Sole entry point that reacquires typed canonical inputs, plans one
model-aware window, reauthorizes mutable authority, and persists an
ordered Invocation Delivery for managed or CLI execution.

**Invocation Snapshot**
Immutable safe record of one Delivery attempt. Stores source refs,
hashes, budget decisions, acknowledgements, and continuity cursors, never
raw rendered context.

**Knowledge Item**
Structured, review-gated Knowledge entry. Backend
`/api/v1/knowledge*`; frontend `/knowledge/wiki`.

**Card**
Schema-only spaced-repetition row (`cards` / `card_review_states` /
`card_reviews`). No server module and no review UI.

**Capability**
A code-defined skill (`capability.yaml` / capability-definitions). Not
an official optional module (`package` plugins).

**Tool**
An action a capability or System Action can perform. Permissions and
grants are enforced by Policy / SystemActionGateway.

**Sandbox / execution host**
CLI Runs execute on a registered host daemon: bubblewrap on the built-in
host, native on a paired trusted host (ADR 0016).

**Managed Mode**
Run tracked, logged, and (on the built-in host) isolated by Rainver.

---

## Ontology Vocabulary

Rainver's object model is compared against the Palantir Foundry Ontology's
Language / Engine / Toolchain decomposition in
[ADR 0012](decisions/0012-ontology-ownership-and-language-alignment.md).
Vocabulary was aligned **only where the semantics genuinely match**. This
section records both the alignment and the deliberate non-equivalences, so
that borrowed terms are not read as borrowed capabilities.

**Object Type**
The closed, code-declared kind of a `space_objects` row (`knowledge_item`,
`note`, `source`, `claim`, `inquiry_thread`, …). Determines ownership, read
gating, and which interfaces apply. Declared in the ontology registry, not in
per-space data.

**Object Profile** (was `object_kind`)
A per-space, governed configuration layer *under* one Object Type: label,
field schema, extraction/retrieval policy, and UI config. Renamed from "kind"
because `type` and `kind` are near-synonyms in English while these are
different layers. A profile changes presentation and defaults; it can never
create a new Object Type or move a row across domain ownership.

**Link Type** (was `relation_type`)
A code-declared edge type on `object_relations`, carrying its legal endpoint
Object Types and its governance level (direct write or proposal-gated). The
term became accurate only once endpoints were declared and constrained; before
that the column was an unconstrained string.

**Interface**
A declared capability of an Object Type: `ContentAccessible`, `Retrievable`,
`Graphable`, `Evidenceable`, `Governed`. Declared in the ontology registry; a
declaration must be backed by an implementation. Replaces the previously
parallel per-mechanism type lists.

**Aggregate Root**
A domain table with independent identity, cross-domain references, or its own
visibility requirement. Only aggregate roots become `space_objects` rows.

### Deliberate non-equivalences

Terms *not* adopted, and capabilities *not* implied by the terms that were:

- **`SYSTEM_ACTION_REGISTRY` is not renamed to "Action Type."** It also carries
  actions that operate on no single object (connection creation, backfill
  start, `authorization.request`), which a Foundry Action Type never does. Its
  entries with a non-empty `applies_to` are the object-bound subset.
- **Proposal is not "Submission Criteria."** In Foundry, review conditions are
  embedded in an action definition. Here a Proposal is a first-class entity
  with its own table, lifecycle, applier registry, and policy gate — a heavier
  concept that the borrowed term would understate.
- **There is no Object Set query language and no typed client SDK.** Reads go
  through owning module services and the content read gate.
- **There is no Workshop equivalent.** Applications are built as frontend
  modules, not composed from the ontology at runtime.
- **There is no ontology branching, release, or staged rollout.** Definition
  changes are code changes; schema cutover is a full database reset.
- **Object Types are code, not data.** There is no user-facing self-service
  modelling surface. Third-party extension happens through plugin modules that
  register into the ontology registry and ship their own migrations.
