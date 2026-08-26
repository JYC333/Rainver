# Module: Knowledge Base

## Status
**BACKEND + FRONTEND MVP IMPLEMENTED** — Knowledge is the first-level product module
(it replaced the old first-level "Wiki"). Backend has the canonical schema,
`/api/v1/knowledge` API, and proposal apply handlers. Frontend: `/knowledge` is a thin
entry that redirects to the last-used workspace (default `/knowledge/notes`);
`/knowledge/home` is an **optional** overview hub, never the forced landing. Sub-areas
(Notes / Wiki / Sources / Cards) switch via an in-header breadcrumb switcher
(`Knowledge / Notes ▼`) — there is **no** Knowledge scene sidebar or tab strip, so each
workspace owns its own layout. Notes is a working-knowledge workspace (configurable
collection tree + open-note tabs, create / edit + links/backlinks); Wiki is the KnowledgeItem browser under
`/knowledge/wiki`; Sources lists evidence; Cards is a clean placeholder. The backend
already supports source list/create/get/update/archive and item-source link CRUD;
the current web client exposes Sources as list-only evidence browsing. Automatic
generation, assessments, card generation, and richer search remain future work.

### Frontend information architecture
- **Knowledge** is first-level; **Notes** are working knowledge; **Wiki** is powered by
  `KnowledgeItem`; **Sources** and **Cards** are Knowledge sub-areas.
- `/knowledge` opens the last-used workspace by default (Notes on a fresh client); the
  overview is reached intentionally at `/knowledge/home`, not forced on every visit.
- Cross-section navigation is the breadcrumb switcher in `KnowledgeSectionHeader`
  (last-used section persisted via `rememberKnowledgeSection`, excluding `home`).
- The Notes collection tree is **local to the Notes workspace** and loaded from the backend,
  never a third-level global nav tier. PARA (Inbox / Projects / Areas / Resources / Archive)
  is only the default initialization template for a space. `NotesPage` claims
  `notes/*`, and the open note is read from the path, so the tree + tabs stay
  mounted while switching notes.
- `NotesPage` and `NoteEditor` are **route-agnostic**. The page takes a
  `NotesSurfaceScope` (`basePath`, `tabsScopeKey`, `renderHeader`) and the editor
  takes `noteId` + `onNoteResolved` as props — no `useParams`, no
  `useOutletContext`. There is exactly one note editor implementation; a second
  note surface mounts this one rather than growing its own.
#### Project notes surface

`/projects/:projectId/notes` mounts the same `NotesPage`, pinned and hoisted to
that Project's `system_role = 'project'` collection. The former Research Area
Notebook tab and its weaker `ProjectNoteCard` editor are removed;
`NotebookChatPanel` lives beside the shared editor on the Project surface.

Project membership is by placement in that collection subtree, while governance
ownership remains the note's single `space_objects.primary_project_id`.
The first placement into a Project binds an unowned note through the Project
writer gate. Cross-Project placement is the explicit scope-only share described
below; ordinary note and folder moves cannot cross a Project workspace boundary.

Project collection reads follow the Project ACL, including descendant folders,
so the global Notes tree does not reveal private Project names or structure.
Existing workspaces can be opened by Project viewers; creating the workspace or
mutating its folders and note placements requires Project writer authority.

#### Hoisting

Borrowed from Trilium. Hoisting makes a chosen folder the temporary tree root:
its subtree is the whole surface, and — the part that matters — the **note query
is narrowed with it**, not only what is drawn.

- Entered and left from the folder menu (`Focus on this folder`) and from the
  bar the tree shows while hoisted.
- The hoisted subtree is computed client-side (`hoistedCollectionIds`) and sent
  as `collection_ids` on `GET /knowledge/notes`. `collection_id` (singular)
  still means "one folder's contents in the user's manual order";
  `collection_ids` means "restricted to this set of folders".
- Searching in the header searches the **whole surface** — the hoisted subtree,
  or the Space when not hoisted — rather than only the selected folder, and
  results carry the folder they live in.
- Open-note tabs are keyed by hoist root (`rainver:notes-tabs:<scope>:<root>`),
  so tabs opened inside one root do not follow the user into another.
- `system_role = 'project'` folders are marked in the tree as workspace roots,
  so it is visible where hoisting is meaningful.
- Hoist state is **session-scoped, per surface**
  (`rainver:notes-hoist:<scope>`, `sessionStorage`) — it is a working
  posture like the open tabs, not a durable preference, and it is deliberately
  not synced across devices.

## Purpose
**Knowledge** is the unified, human-browsable long-term content module. It is split
into subdomains by *lifecycle*, not just by view:

- **Notes** — *working knowledge*: evolving meeting/design/research/thinking notes,
  edited freely via direct CRUD (no proposal gate). Table `notes`.
- **Wiki** — *canonical knowledge*: stable concepts, definitions, structured pages,
  graph relations and evidence. Review-gated and versioned. Table `knowledge_items`.
- **Sources** — external references / evidence. Table `sources`.
- **Cards** — review/learning artifacts derived from Notes/Wiki/Sources.
  Space-scoped content (`cards`); user-specific scheduling state (`card_review_states`);
  append-only review history (`card_reviews`). FSRS algorithm implementation deferred.

Notes and Wiki are **related but not the same**: Wiki is not merely a different view
of Notes. The working/canonical split is the reason they are separate models — folding
freely-editable notes into the proposal-governed `knowledge_items` table would break
its "everything here was reviewed" guarantee, so Notes get their own lightweight model.

Capture / Activity is *raw material* upstream of all of this and is not Knowledge.

Backend and API naming uses `knowledge`; space-specific product labels are
presentation concerns. Knowledge is distinct from Memory: Memory is agent
context; Knowledge is durable content for people to inspect, revise, relate, and reuse.

No removed route or compatibility alias exists. The API path is `/api/v1/knowledge`;
canonical table names are `space_objects`, `notes`, `note_collections`,
`note_collection_items`, `knowledge_items`, `sources`,
`knowledge_item_sources`, `claims`, `claim_sources`, and `object_relations`.
Wiki proposal types use `knowledge_*`, claim proposal types use `claim_*`,
object relation proposal types use `object_relation_*`, and
`claim_candidate_packet` is the review packet bridge from retrieval artifacts
into child claim/object-relation proposals
(notes are not proposal-gated).

## Layers

| Layer | Table | Write path | Role |
|---|---|---|---|
| **SpaceObject** | `space_objects` | owned by concrete object write path | shared space-scoped object root for common metadata |
| **Note** | `notes` | direct CRUD | working knowledge that evolves freely |
| **NoteCollection** | `note_collections` | direct CRUD | space-scoped folder tree for organizing notes |
| **KnowledgeItem** (Wiki) | `knowledge_items` | proposal → approval | canonical, versioned knowledge |
| **Source** | `sources` | direct CRUD | provenance / evidence |
| **KnowledgeItemSource** | `knowledge_item_sources` | direct CRUD | wiki item ↔ source evidence |
| **Claim** | `claims` | proposal → approval | global semantic atom attached to `space_objects` |
| **ClaimSource** | `claim_sources` | proposal → approval with claim writes | claim ↔ evidence/source-policy path |
| **ObjectRelation** | `object_relations` | proposal → approval | canonical FK-backed cross-object graph over `space_objects` |
| **Card** | `cards` | direct CRUD (future) | space-scoped review card derived from knowledge objects |
| **CardReviewState** | `card_review_states` | scheduler-written (future) | per-user FSRS scheduling state; one row per (card, user) |
| **CardReview** | `card_reviews` | append-only (future) | per-user review history with rating + state snapshot |

Notes on the wiki layers: `source` is **not** a KnowledgeItem type — it is the `sources`
table. `answer` **is** a canonical KnowledgeItem type (a `question` item and its `answer`
item are linked with a generic `related_to` relation; there is no dedicated `answers`
relation type). `ObjectRelation` is the governed cross-object graph;
`KnowledgeItemSource` is item↔source evidence; the two must not be conflated.
`ProvenanceLink` records accepted lineage into memory/policy/knowledge targets.

Wiki pages read canonical backlinks through `object_relations`. Notes also expose
direct working-note links through `note_links`; those links are not canonical graph
authority and are not projected into retrieval edges.

### Notes vs Collections

Collections/folders are organization *views*, not sole ownership, and a note may appear
in many. The `note_collections` tree is space-scoped and user-configurable; PARA is seeded
only as the initial folder template. A note still belongs to global Knowledge, never to a
separate per-project note system.

`note_collection_items` stores `space_id` and uses composite foreign keys to ensure
collections and notes belong to the same space. `note_collections.parent_id` is also
constrained by `(parent_id, space_id)` so folder trees cannot cross spaces.

#### Placements

`note_collection_items` is unique on `(collection_id, note_id, space_id)`, so
multi-placement has always been expressible; the reads and the reorder path
collapsed it. Both are now placement-addressed:

- `NoteSummary.placements` is `[{ collection_id, sort_order }, …]` in placement
  order. There is no scalar `collection_id` on a note — a note is not in "the"
  folder. `NOTE_PLACEMENTS_JOIN` is the single query fragment that produces it.
- The tree draws one row **per placement**, keyed `${collection_id}:${note_id}`.
  Selection, the context menu and reordering all address that row.
- `PATCH /knowledge/notes/tree/reorder` note updates carry
  `{ note_id, from_collection_id, collection_id, sort_order }`. `from_collection_id`
  is what identifies the row; matching on `note_id` alone rewrote every placement
  of a note to one folder, destroying the others.
- Adding a placement is a **separate action** from moving one:
  `POST /knowledge/notes/{id}/placements` (Alt-drop in the tree) versus the
  reorder above. `noteWriter.moveNoteToCollection` replaces every placement and
  backs creation and an explicit `collection_id` on a note update;
  `addNotePlacement` adds one.
- `DELETE /knowledge/notes/{id}/placements/{collectionId}` removes one and
  **refuses the last** (422): losing a note is a different decision from taking
  it out of a folder, and has its own action.

#### Cross-Project placement

A note's Project is single-valued (`primary_project_id`) and the content read
gate treats it as a hard AND, so placing a note in a second Project's folder is
meaningless unless that Project's members can read it. Both halves happen
together or neither does:

- `POST /knowledge/notes/{id}/placements` into another Project's subtree returns
  `409` with `code: note_cross_project_share_required` and the owning project
  id. The client turns that into a confirmation naming what it does, then
  re-issues with `share_with_project: true`, which creates the placement **and**
  a `space_object_project_shares` row.
- The tree reorder path refuses outright and has no confirmation — a drag must
  not be able to change who can read something.
- `GET /knowledge/notes/{id}/shares` lists the Projects a note reaches, and
  `DELETE /knowledge/notes/{id}/shares/{projectId}` withdraws one, taking the
  note's placements inside that Project with it. Both are surfaced on the
  note itself, behind a `Shared` status-bar chip that appears only once a note
  is actually shared. The list filters target Projects through the caller's
  Project read ACL, so access to the owning Note cannot reveal a private target
  Project's id, name, or sharing metadata.
- A share is read-only for the receiving Project. Note edits, rollback, delete,
  jot append, and link create/delete require writer authority in the Note's
  `primary_project_id`; the read-scope share never supplies that authority.

The access semantics — scope only, never a grant — are in
`architecture/SECURITY_AND_ACCESS_BOUNDARIES.md`.

#### Quick capture

`POST /knowledge/notes/jot` takes an **optional** `target_id`:

- **With one** — one note per object and Project scope, appending on repeat, and
  the `note_links` edge recorded in the same call. The server resolves the
  existing linked Note even when the client omits `note_id`; a transaction-level
  advisory lock serializes concurrent first captures for the same target.
- **Without one** — `project_id` is required and the text appends to that
  Project's `inbox` note, created on first use in the Project's notes folder.
  The inbox is resolved by `project_role = 'inbox'`, never by title, so renaming
  it does not silently start a second one.

Neither always-append nor always-create is right on its own: one inbox would
bury ten papers' annotations together, and a note per thought turns the tree
into fragments (U11).

This inbox is the jot's destination, not capture's: the floating composer that
used to append here was merged into the shell's single capture entry, whose
Project destinations are marginalia and raw material (see
[assistant-capture.md](assistant-capture.md)). The inbox note is still what a
contextless `POST /api/v1/knowledge/notes/jot` appends to.

The jot resolver is owner-dimensioned. `noteForJotTarget` passes `null` for the
owner, which matches only unbound, non-`private` notes: both kinds of note are
linked to the same object and the caller can read their own, so without the
split a jot from an evidence card would append team material into a note no
teammate can see. The `private` exclusion is the belt: a marginalia binding is
cleared when its note is archived or moved, and "unbound" alone would then read
as "team note". Marginalia passes its owner instead, and resolves on the binding
columns rather than the link — those columns are also its unique index, so
deleting the link (which the note editor offers) cannot leave the next capture
inserting a row the index rejects.

Reading-list cards offer capture only where the material already has an
`object_id`, and say why when it does not — material becomes a `space_objects`
row when it passes triage (R3), so the absence is a state with a remedy rather
than a missing button.

## Owns
- `Note` model (working-knowledge layer; direct CRUD via `NoteService`)
- `NoteCollection` / `NoteCollectionItem` models (space-scoped Notes folder tree)
- `KnowledgeItem` model (canonical wiki layer)
- `Source` model (independent provenance/evidence layer)
- `KnowledgeItemSource` model (item↔source evidence links)
- `ObjectRelation` model (proposal-gated canonical cross-object graph)
- `NoteLink` model (`note_links`, direct working-note UI links)
- `KnowledgeSummaryService` (Overview counts)
- `/api/v1/knowledge` read and proposal API for wiki items; `/api/v1/knowledge/notes`
  + `/api/v1/knowledge/notes/{id}/links|backlinks` direct CRUD for notes;
  `/api/v1/notes/collections` direct CRUD for the Notes collection tree;
  `/api/v1/knowledge/sources` direct CRUD; `/api/v1/knowledge/items/{id}/sources`
  item-source link CRUD; `/api/v1/knowledge/claims/candidate-packets`;
  `/api/v1/knowledge/summary`
- Knowledge proposal apply handlers for wiki, claim/object-relation writes, and
  Claim Candidate Packets
- Object Schema Registry / object profile routes: owner/admin proposal routes
  for `object_profile_create`, `object_profile_update` (including draft
  activation), `object_profile_deprecate`, and `object_profile_archive`;
  member-visible registry reads; object-schema export/import; and deterministic
  object-schema suggestion scans. These routes and appliers write only registry
  rows/proposals/artifacts, never canonical Knowledge, Memory, Claim, Project,
  relation, or retrieval projection rows. The **storage** behind them belongs to
  the `ontology` module (B12I): the paths stay under `/api/v1/knowledge/` and
  `PgKnowledgeRepository` delegates to `PgOntologyRepository`, so ownership
  moved without a client-visible URL change.
- Note → Knowledge promotion (`POST /api/v1/knowledge/notes/{id}/promote`,
  `GET .../promoted`): a selected passage becomes a normal knowledge-item
  proposal, and the originating Note is recorded as a `provenance_links` row
  with `source_type='note'`. Governance is unchanged — nothing bypasses the
  proposal gate — and the Note keeps its content.
- `POST /api/v1/knowledge/notes/jot` (create-or-append a note plus its
  `note_link` in one call) and `GET /api/v1/knowledge/objects/{id}/note-links`
  (what notes cite this object; the note `backlinks` route is note-keyed on
  both sides and cannot answer it).
- Frontend Knowledge module (breadcrumb switcher, Notes workspace, Wiki/Sources/Cards, overview hub) under `apps/web/src/modules/knowledge/`
- Relation and evidence-link records backed by database rows, not only Markdown links

### Current Sources frontend

Backend source capability is ahead of the visible frontend: `knowledge` routes
support source CRUD and item-source link CRUD, but `apps/web/src/api/client.ts`
currently exposes `sourcesApi.list` only and `SourcesPage` is a list view. Treat
this as current product scope, not as missing backend support.

## Does Not Own
- Raw capture (activity module)
- Agent runtime output storage (runs/artifacts modules)
- Long-term agent context injection (memory module)
- Project taxonomy or Project Folder structure
- Spaced repetition scheduling
- Feynman or Reflection assessment dialogue flows

## Knowledge vs Memory

| Aspect | Memory | Knowledge |
|---|---|---|
| Primary audience | Agent context | Human browsing and review |
| Runtime use | Eligible only through governed Runtime Context acquisition | Must not automatically enter an accepted Delivery |
| Shape | Scoped context entry | Typed item with versioning and relations |
| Write path | Proposal -> approval -> active memory | Proposal -> approval -> active KnowledgeItem |
| Promotion | N/A | Future separate proposal, e.g. `knowledge_promote_to_memory` |

Knowledge items must not be auto-injected into runtime context. Promoting Knowledge into Memory is a separate future flow and is not part of the Knowledge MVP scaffold.

## Retrieval Substrate

Knowledge is the first consumer of the shared retrieval engine
(`server/src/modules/retrieval/`), registering a domain adapter
(`knowledge/retrievalAdapter.ts`) for `KnowledgeItem`, `Note`, `Source`, and
`Claim`. The engine is generic and domain-agnostic; the adapter owns all
Knowledge-specific SQL and the visibility revalidation gate. See
[CONTEXT_AND_RETRIEVAL_LAYER.md](../architecture/CONTEXT_AND_RETRIEVAL_LAYER.md)
for the engine/adapter boundary and the full retrieval + context-layer
architecture. The Object Schema Registry foundation is served under the
Knowledge paths but owned by the `ontology` module: `space_object_profiles`
registry rows are read in the current space, and owner/admin proposal routes
create, update/activate, deprecate, or archive object profiles through
registered proposal appliers. The registry stores
bounded declarative field schemas, extraction hints, retrieval hints, relation
hints, and UI labels/config under fixed retrieval `object_type` values. Object
schema export/import serializes registry definitions; import creates draft
object-profile proposals and never activates definitions directly. This registry is
object schema config only; it does not add retrieval object types or write
canonical Knowledge, Memory, Claim, Project, relation, or retrieval projection
rows. Follow-up retrieval/context-layer quality work and non-goals are tracked in
[ROADMAP_AND_FUTURE_RISKS.md](../architecture/ROADMAP_AND_FUTURE_RISKS.md#retrieval-and-context-layer-stabilization).
Canonical lifecycle ownership does not change:
KnowledgeItem writes remain proposal-gated, Notes and Sources remain direct CRUD,
and retrieval projection rows are derived indexes that can be rebuilt from the
canonical tables.

The initial projection indexes:

- `KnowledgeItem` title, slug, aliases, content/plain text, excerpt, source URL,
  item status, visibility, owner, Project Folder, accepted object relations, and
  item-source evidence links.
- `Note` title, plain text, excerpt, status, Project Folder/project associations where
  present, and working `note_links` rows.
- `Source` title, URI, raw text, summary, status, and item-source links.
- `Claim` title, subject text, claim text, status, visibility, owner, claim
  relations, claim-source evidence links, and object relation edges. Final
  viewer-facing claim snippets after revalidation come from `claim_text` only.

Extracted markdown links, wikilinks, source references, and alias matches are
retrieval evidence or suggested retrieval edges only. They must not create an
accepted `ObjectRelation` unless a user accepts the existing object relation
proposal flow.

Create-safety is advisory duplicate detection for review and proposal creation:
`exists`, `probable_duplicate`, or `unknown`. It explains why a create may match
an existing object, but it does not make retrieval projection authoritative and
does not silently block canonical writes.

Full-space retrieval reindex is a maintenance operation exposed at
`POST /api/v1/knowledge/retrieval/reindex`. It rebuilds derived projection rows
for the caller's space and requires space owner/admin authority.

## Activity-First Input Boundary

Raw user input, session content, file imports, web captures, and run outputs enter Activity, Run, or Artifact first. Future Knowledge generation normally follows:

```
Activity / Run / Artifact
-> knowledge proposal
-> proposal acceptance
-> active KnowledgeItem / ObjectRelation
```

Agent-generated knowledge never becomes active without proposal approval.

## Knowledge Kinds

`KnowledgeItem.knowledge_kind` is restricted to these canonical Wiki kinds:

| Kind | Purpose |
|---|---|
| `concept` | A definition, idea, or named concept |
| `lesson` | Learned principle or takeaway |
| `procedure` | Repeatable steps or operating procedure |
| `decision` | Decision record or rationale |
| `question` | Open question |
| `answer` | An answer to a `question` item (linked via `related_to`) |
| `summary` | Digest of an Activity, Run, Artifact, or Source |

`source`, `idea`, `experience`, and `reflection` are **not** canonical Wiki item types.
`source` is the `sources` table (provenance/evidence). Ideas, experiences, and
reflections are working-note / activity concepts and belong in **Notes** or **Activity**,
not the proposal-governed `knowledge_items` table. (Daily-capture "experience"
candidates land as canonical `summary` KnowledgeItems.)

The default `knowledge_kind` for the create proposal is `concept`. Some kinds may later
gate on assessment flows (e.g. a Feynman/Reflection gate); these are future and must not
block the MVP persistence/API slice.

## Proposal Types

- `knowledge_create` creates an active KnowledgeItem.
- `knowledge_update` creates a new version, not an in-place overwrite.
- `knowledge_archive` archives an item.
- `object_relation_create` creates a relation only within the same space.
- `object_relation_delete` removes or archives a relation.

These proposal types are supported by `ProposalApplyService`. They remain review-gated and are not direct-write API operations.

`knowledge_create` sets `owner_user_id` to the proposal creator. Ownership cannot be assigned to another user through the Knowledge API; sharing is managed through the content-access API.

Proposal creation is viewer-aware, and proposal apply performs defense-in-depth
authorization again. Malformed, internally seeded, or future system-created
proposals cannot update, archive, relate, or archive relations involving another
user's private or selected-user Knowledge without canonical access. Agent/run
provenance is not treated as human ownership authority.

## Read Visibility

Knowledge reads are viewer-aware:

- `space_shared` is readable by any authenticated member of the current space.
- Project Folder-scoped `space_shared` is readable by any authenticated member of the current space for now. Project Folder-role narrowing is future work.
- `private` has owner base access and never consults grants; private content
  cannot omit its owner.
- `selected_users` requires an active grant in `content_access_grants` for an
  ordinary non-owner reader.
- An active owner/admin may receive the Space's immutable read-only oversight
  level over otherwise-hidden rows. Oversight does not grant Knowledge mutation,
  relation-apply, publication, proposal-approval, or access-policy authority.
- `space_shared` grants may upgrade a named reader's summary disclosure to full;
  a `selected_users` grant's level is authoritative for that reader.

Private or selected-user rows require `owner_user_id`. Unauthorized reads
return 404 and must not reveal existence.

`GET /api/v1/knowledge/items` returns summary rows with `content_preview`; `GET /api/v1/knowledge/items/{id}` returns full content.

Relation reads first require the requested item to be visible to the viewer, then omit any relation where either endpoint is not visible to the viewer.

Relation apply uses the same endpoint visibility authority: private endpoints
require their owner, selected-user endpoints require an active grant, and shared
endpoints remain collaborative within the current scope.

## Source Monitoring

Knowledge proposal apply currently relies on proposal approval and the `proposal.apply` policy gate. `ProposalApplyService._enforce_source_monitoring()` has an explicit Knowledge branch documenting that full Knowledge source monitoring is future work. External or untrusted Activity/Artifact-derived Knowledge requires a future evaluator and must not be treated as safe merely because the current branch does not block.

## Policy Actions

- `knowledge.create`
- `knowledge.update`
- `knowledge.archive`
- `knowledge.relation_create`
- `knowledge.relation_delete`
- `claim.create`
- `claim.update`
- `claim.archive`
- `claim.relation_create`
- `claim.relation_delete`
- `object_relation.create`
- `object_relation.delete`

These actions are `WIRED_VIA_PROPOSAL`: durable mutation is protected by `proposal.apply` and `ProposalApplyService`, not direct `PolicyGateway.enforce()` call sites. Unknown or not-yet-implemented Knowledge actions must fail closed.

## Project And Project Folder Association

Project is not a Knowledge type. Project Folder is not a Knowledge type. They are contextual associations.

KnowledgeItem rows may carry `project_id` and/or `project_folder_id`, but the primary content model must not be a project tree taxonomy.

## Models

```text
SpaceObject:                           # identity-and-governance root for every ontology object
  id, space_id                    # not Knowledge-owned: `ontology` owns the root (B12I)
  object_type                     # knowledge_item|note|source|person|organization|
                                  #   claim|inquiry_thread|decision_case|experiment
  title, summary                  # title is a projection of the domain's own label
  visibility, access_level
  owner_user_id, primary_project_id, project_folder_id
  created_by_user_id, created_by_agent_id, created_by_run_id
  created_at, updated_at, archived_at, deleted_at
                                  # NO status column — domain status lives on the
                                  #   extension tables (ADR 0012 / B12D/B12E).
                                  # Every insert goes through db/spaceObjectWriter.ts,
                                  #   which enforces the B12H rules (project scope,
                                  #   validated visibility/access level, title
                                  #   truncation, at least one of user/agent/run
                                  #   provenance, registered object type). A guard
                                  #   test fails if anything else writes the table.

Note:                                 # working-knowledge layer (direct CRUD)
  object_id, space_id             # object_id is PK/FK to SpaceObject.id
  content_json                    # ProseMirror/Tiptap JSON
  content_format                  # markdown|plain|prosemirror_json
  content_schema_version          # int, default 1
  plain_text                      # derived projection for preview / future search
  status                          # active|archived|deleted (domain-owned)
  version, content_hash           # optimistic version + revision history
  created_from_activity_id        # optional capture provenance (FK activity_records)
  project_role, role_project_id   # system-reserved Project notebook role (N2/N3):
                                  #   understanding|questions|ideas|experiments,
                                  #   one per role per project (partial unique index).
                                  #   Membership is owned by
                                  #   modules/knowledge/noteProjectRoles.ts (B12F);
                                  #   the column carries only a format constraint.
                                  #   The role — never the title — is what binds the
                                  #   Project research baseline.

NoteLink:                             # working note UI links (direct CRUD; not canonical graph)
  id, space_id
  from_object_id, to_object_id    # composite FKs to SpaceObject(id, space_id)
  from_object_type, to_object_type  # both endpoints must be readable space_objects,
                                  #   so the offered targets are the intersection of
                                  #   linkable and searchable: note, knowledge_item,
                                  #   source, claim, inquiry_thread. Derived from
                                  #   NOTE_LINK_TARGET_TYPE_VALUES and guarded by
                                  #   test/noteLinkTargetsGuard.test.ts, never
                                  #   hand-maintained in the editor.
  link_type                       # related_to|references|depends_on|part_of|
                                  #   source_for|derived_from|about|supports|...
  confidence
  status                          # active|archived
  metadata_json                   # includes canonical_graph=false
  created_by_user_id, created_at, updated_at

ObjectRelation:                       # governed FK-backed graph layer
  id, space_id
  from_object_id, to_object_id      # composite FKs to SpaceObject(id, space_id)
  link_type                         # one vocabulary (protocol/linkTypes.ts, 23 values),
                                    # with legal endpoints, per-link-type governance
                                    # (direct|proposal), and retrieval projection
                                    # declared in modules/ontology/linkTypes.ts.
                                    # The database keeps a format constraint only;
                                    # the registry owns membership (B12F).
                                    # Renamed from relation_type on ontology edges
                                    # only — memory_relations.relation_type and
                                    # knowledge_item_sources.relation_type are
                                    # deliberately separate vocabularies (B12A).
  confidence
  status                            # candidate|active|rejected|archived;
                                    # create packets accept candidate|active only
  source_claim_id, source_object_id, source_proposal_id
  retrieval_projected               # response-only; true when both endpoints are
                                    # indexed by Knowledge retrieval
  metadata_json
  created_by_user_id, created_by_agent_id
  created_at, updated_at

KnowledgeItem:
  object_id, space_id             # object_id is PK/FK to SpaceObject.id
  root_item_id, supersedes_item_id
  redirect_to_item_id             # self-FK; readiness for future merge/rename/deprecate
  knowledge_kind                  # canonical Wiki kinds above
  slug                            # readable-URL slug; indexed (space_id, slug), NOT unique
  aliases_json                    # alternate names for future search/linking
  content
  content_json                    # ProseMirror/Tiptap JSON once a rich editor is wired
  content_format                  # markdown|plain|prosemirror_json
  content_schema_version          # int, default 1
  plain_text                      # derived projection for search/preview/LLM context
  verification_status, reflection_status
  tags_json, confidence, source_url
  source_activity_id, source_artifact_id, created_from_proposal_id
  approved_by_user_id

Claim:
  object_id, space_id             # object_id is PK/FK to SpaceObject.id
  subject_object_id, subject_text
  claim_kind                      # fact|hypothesis|belief|preference|commitment|
                                  # question|interpretation|instruction|metric|
                                  # relationship|event
  claim_text, normalized_claim_hash
  holder_object_id, holder_type, holder_id
  confidence, confidence_method
  resolution_state                # unreviewed|confirmed|contradicted|stale|needs_source
  valid_from, valid_until, observed_at
  metadata_json
  created_from_proposal_id, approved_by_user_id
  lifecycle                       # enforced by proposal creation/apply:
                                  #   create active|disputed|rejected
                                  #   active -> disputed|superseded|archived
                                  #   disputed -> active|superseded|archived
                                  #   superseded|rejected -> archived
                                  #   archived terminal
  superseded_by_claim_id          # claim_update packet field; persisted into
                                  # metadata_json when supplied

ClaimSource:
  id, space_id, claim_id
  source_object_id                # optional FK to SpaceObject(id, space_id)
  source_ref_type, source_ref_id
  source_connection_id            # FK to SourceConnection(id, space_id);
                                  # required whenever source_ref_type/source_ref_id is used
  source_policy_snapshot_json
  locator, quote_excerpt
  evidence_role                   # supports|contradicts|mentions|derived_from|cites|summarizes
  source_trust, confidence, metadata_json
  created_by_user_id, created_at

Source:                               # independent provenance / evidence layer
  object_id, space_id             # object_id is PK/FK to SpaceObject.id
  source_type                     # activity_record|chat_capture|webpage|article|
                                  #   paper|pdf|file|email|manual_reference|external_note
  uri, content_ref, raw_text, summary, metadata_json
  source_activity_id              # optional FK back to the raw ActivityRecord

KnowledgeItemSource:                  # item <-> source evidence link
  id, space_id
  knowledge_item_id, source_id
  relation_type                   # derived_from|supported_by|cites|summarizes|mentions
  locator, quote, note, confidence
  created_by_user_id
  created_at
```

Relation creation must enforce same-space endpoints. `ObjectRelation` is the
proposal-gated semantic graph; `KnowledgeItemSource` is the item↔source evidence
layer; `note_links` is a direct working-note UI edge. The three must not be
conflated. Sources are evidence/raw material, so Source and KnowledgeItemSource use
direct CRUD (`/api/v1/knowledge/sources`, `/api/v1/knowledge/items/{id}/sources`)
rather than the proposal workflow that gates semantic KnowledgeItem and
ObjectRelation writes. A Source may point back to an
existing ActivityRecord via `source_activity_id` (or any other origin via
`content_ref` / `metadata_json`); ActivityRecord remains the raw capture layer and is
not replaced by Source.

> Frontend follow-up: Sources should surface as a Wiki sub-tab / evidence panel, not
> as ordinary wiki items.

## Invariants

- **Wiki** (canonical KnowledgeItem) durable writes go through proposals; agent-generated
  wiki knowledge never directly becomes active.
- **Notes** (working knowledge) are direct-CRUD and **not** proposal-gated; they are
  space-scoped and never auto-injected into Memory/Runtime Context. Notes are not wiki:
  they carry no verification/reflection status and do not share the proposal path.
  (They *do* version — every save goes through `noteRevisionService.writeNote`,
  which bumps an optimistic version and writes a full-content revision row.)
  The one route from a Note into canonical Knowledge is the promotion channel:
  a selected passage becomes an ordinary knowledge-item proposal, so the gate is
  unchanged and the Note is left intact.
- `getNoteRow` and `getSourceRow` apply the content read gate. They are the
  shared lookup behind every single-object read *and* every mutation, so a
  caller cannot update, delete, or roll back a note it cannot read — a rule
  applied only to the list route is not a rule.
- **Every note write goes through `knowledge/noteWriter.ts`.** `withNoteWrites`
  owns the transaction and hands out a scope; creating, writing, applying AI
  block ops, rolling back, and assigning a Project role are its methods, and
  nothing else in `src/` writes a `notes` row. It exists because the three
  things around a note write were each the caller's job and each was missed:
  creation had drifted into two implementations (the Project one wrote no
  `summary` and filed every note at `sort_order` 0), the retrieval reindex was
  done by the user-facing path and by no agent path, and the Project role was
  written from three places of which one knew the rules. Same argument as the
  `space_objects` writer, one level up (B12H).
- **Binding a note to a Project is a write to that Project.** `primary_project_id`
  on create or update requires `assertProjectWriter`, enforced in the writer.
  This was unchecked and harmless while the field was a label; it stopped being
  harmless when `project_role` became the research baseline, because assigning
  a role deliberately displaces the previous holder, so any Space member could
  take over another Project's baseline note.
- Reindexing happens **after** the transaction commits when the writer owns it,
  and inside the transaction behind a savepoint when it joined someone else's.
  The projection is derived and rebuildable, so a failure is logged rather than
  raised — but swallowing a database error inside an open transaction poisons
  every later statement in it, which is what the savepoint prevents.
- `object_relations.from_object_id` / `to_object_id` are FK-backed
  `space_objects` endpoints in the same space, and an object cannot link to itself.
- **Card content** (`cards`) is space-scoped; any member of the space can see cards
  in that space. **Card review state** (`card_review_states`) and **review history**
  (`card_reviews`) are user-specific. `cards.source_id` is polymorphic (no FK;
  covered by `server/test/baselineSchema.test.ts`). The FSRS scheduling fields on
  `card_review_states` are nullable — a state row can be created before first review.
- Durable Knowledge writes go through proposals.
- Agent-generated Knowledge never directly becomes active.
- Private Knowledge reads are owner-only; selected-user reads require grants.
- Knowledge does not automatically enter Memory or an accepted Runtime Context Delivery.
- Knowledge promotion into Memory is a future explicit proposal flow.
- Activity, Run, and Artifact are raw/source inputs, not active Knowledge.
- Project and Project Folder are associations, not Knowledge content categories.
- Updates are versioned; active content is not overwritten in place.
- Relation rows are database-backed and same-space only.
- Backend/domain/API naming uses `knowledge`; frontend-specific labels are presentation-only.
- No removed-route compatibility is provided.
- No historical data migration compatibility is required.

**Enforced by tests:**
- `server/test/leafDomainInvariants.test.ts` — knowledge proposals do not auto-promote into memory and server proposal appliers own accepted knowledge mutations.
- `server/test/leafDomainRepositoryBehavior.test.ts` — repository behavior around leaf-domain proposal boundaries.
- Payload validation is enforced at apply time in `KnowledgeProposalApplier`: `knowledge_kind`, `content_format`, `visibility`, `verification_status`, `reflection_status`, and `confidence` for items; `link_type`, `status`, and `confidence` for relations. `link_type` legality — vocabulary, endpoint types, and whether the write may be direct — is checked by `assertLinkTypeAllowed` against `modules/ontology/linkTypes.ts`, which every `object_relations` writer must call.

## Related Files
- `server/src/modules/knowledge/` - API, service, schemas, read models, and proposal appliers
- `server/src/db/schema/` - Drizzle schema declarations for canonical tables (incl. `notes`, `object_relations`, `cards`, `card_review_states`, `card_reviews`)
- `server/migrations/` - generated/applied SQL artifacts
- `server/test/` - live schema and API tests for Knowledge/Cards surfaces
- `server/src/modules/policy/` - Knowledge policy actions wired via proposal
- `server/src/gateway/routeRegistry.ts` - active backend module registry entry
- `apps/web/src/modules/knowledge/` - `KnowledgeModule` (index redirect + routes), `KnowledgeSectionHeader` (breadcrumb switcher), `utils.ts` (last-used section storage + canonical vocabularies), `KnowledgeOverviewPage` (`/knowledge/home`), `NotesPage` workspace + `NoteEditor`, `KnowledgePage`/`KnowledgeDetailPage` (Wiki), `SourcesPage`, `KnowledgeCardsPanel`
- `apps/web/src/core/navigation.tsx` - first-level "Knowledge" rail item only (Knowledge has **no** scene; sections switch via the in-header breadcrumb)
- `server/test/` - ingestion/review boundary and API contract tests

## Related Modules
- [../architecture/SOURCE_EVIDENCE_FOUNDATION.md](../architecture/SOURCE_EVIDENCE_FOUNDATION.md) - the two evidence stacks (source candidate vs curated wiki `Source`/`KnowledgeItemSource`), their hard separation, and the source→wiki promotion rule spec
- [memory.md](memory.md) - Memory is agent context, not the Knowledge browser
- [activity.md](activity.md) - raw input and source events
- [spaced-repetition.md](spaced-repetition.md) - future card generation from approved Knowledge
- [proposals.md](proposals.md) - proposal review and apply boundary

## TODO
- Notes: richer collection management. (The Tiptap editor, the cross-type link
  picker, and Note → Wiki promotion all landed; promotion records the source
  Note in `provenance_links` rather than `object_relations`, because
  provenance — not a semantic graph edge — is what "this item came from that
  note" is.)
- Plain-text/excerpt + search projection regeneration from `content_json`
- Later Feynman and Reflection assessments
- Automatic Activity/Artifact to Knowledge proposal generation
- Source monitoring evaluator for Knowledge proposals
- **Cards — next slice**: card generation workflow (from Notes/Wiki/Sources → Card rows),
  direct CRUD API under `/api/v1/knowledge/cards`, FSRS review scheduler, and the
  frontend review UI. Schema (cards / card_review_states / card_reviews) is in place.
