# Frontend Information Architecture

## 1. Frontend Role

The frontend is the primary command surface for the Rainver product loop. It provides
access to: capture, activity inbox, proposals, runs, tasks, memory, Project Folders, runtime
status, structured Plan execution, Automation scheduling, and the Evolution review loop.

The frontend must respect backend security and access boundaries at all times. Every data
call is made inside `RequireAuth`; the backend enforces space-scoped visibility, and the
frontend must not expose information about objects the user cannot access.

Detail and review panels distinguish an unavailable read from an empty result. In particular,
Run Detail attempts, evaluations, verifications, finalizations, and route decisions show an
explicit unavailable state with the server error when their read model fails; an empty history
means the read succeeded and contains no records. Evolution Inbox also preserves historical
bundle ownership for released members so they cannot be selected into a new bundle when the
database uniqueness rule still owns that proposal's history.

Run Detail child-resource loading is scoped by `(spaceId, runId)` and a request generation;
late responses from a previous Run or Space are ignored, and a new scope cannot render the
previous scope's child records while loading. Workflow-save previews are cleared when preview
starts, when preview inputs change, and when preview fails; a response is accepted only when
its generation, `(spaceId, runId)` scope, and normalized name/description snapshot still match
the current dialog. Changing Run or Space closes and resets the dialog, so Save always requires
a successful preview for the current Run and input.

The frontend should guide users through the product loop rather than act as an app gallery.
The goal is a working system the user interacts with daily — not a navigation menu of features.

---

## 2. Dogfooding Loop

The primary product loop:

```
capture
  → activity inbox
  → activity detail / consolidate
  → generated proposals
  → proposal review (accept / reject)
  → accepted memory / task / code result
  → continue working
```

All frontend modules are oriented around this loop. Home is the entry point. Activity Inbox
is the processing queue. Proposals is the review and acceptance surface. Memory, Tasks, and
Artifacts are the outputs.

---

## 3. Home and Space Scope Model

There are exactly two route scopes (`routeScopeForPath` in `src/core/navigation.tsx`):

| Scope | Routes | Data source | Write target |
|---|---|---|---|
| `home` | `/`, `/home`, and neutral system surfaces (`/settings`) | `meApi` cross-space `/me/*` aggregate (no `space_id` param) | the personal-inbox capture destination always targets the user's **Personal Space** |
| `space` | `/spaces/:spaceId/*` (`…/today`, `…/activity`, `…/knowledge`, …) | space-scoped APIs bound to the URL's `:spaceId` | Project entry points create shared Project content; creation without Project context targets Personal Space privately |

**The active Space lives in the URL.** Space-scoped routes are `/spaces/:spaceId/<module>`;
`activeSpaceId` is **derived from the route params** (`useMatch('/spaces/:spaceId/*')` in
`SpaceContext`), never from local/`localStorage` state. This makes Space a first-class,
deep-linkable, per-tab dimension and removes cross-tab interference. There is no imperative
"set active space" — to switch Space you navigate to its URL. `preferredSpaceId`
(active → last visited → default → personal) is the Space targeted when following a space link
from a user-scoped surface. `SpaceContext` does not persist an active Space or write destination;
its last-visited fallback is in-memory for the current app session. Logical in-space paths are
composed with `spacePath()` / `useSpaceNavigate` /
`SpaceLink` (`src/core/spaceNav.tsx`); the API client's space header is synced from the URL
before page effects run.

Rules enforced by the frontend:

- **Home is user-scoped, not a Space.** `/home` shows the cross-space command center and is
  **never** filtered by the active Space. `activeSpaceId` is null on Home and only governs
  `/spaces/:spaceId/*` routes.
- **Home is not a Space Switcher option.** The switcher lists only real Spaces
  (Personal / Family / Team). Selecting one navigates to `/spaces/:spaceId/today`; it never
  mutates Home.
- **Personal Space is a real data container, not the cross-space overview.** It uses the same
  Space UI as any other Space and does not aggregate other spaces.
- **Capture is one affordance with several destinations.** A single floating
  composer serves every page and posts to `POST /api/v1/captures`. The
  `/capture` page is a separate full-page surface for the personal inbox only —
  it carries the file-upload and voice affordances the composer does not and
  posts to `POST /api/v1/activity`; it offers no destination choice. Outside a
  Project the only destination is the personal inbox, which lands in the user's
  Personal Space regardless of the Space being browsed. Inside a Project it
  offers four: marginalia on the Area's declared object, Project marginalia,
  Project raw material, and the personal inbox. The destination and its
  consequence are shown on one line before anything is typed
  (`→ marginalia on H3 · only you`), and the default is inferred from *where the
  text came from* — a paste event or a URL defaults to Project raw material,
  hand-typed text to marginalia. The default is never remembered across
  captures (ADR 0013 decision 2). In a single-member Space the "only you / team
  visible" half of each line is dropped; what is stored is identical.
- **Creation has no per-module visibility picker.** Acting inside a Project is
  the sharing decision; acting without Project context creates privately in
  Personal Space. Existing content uses the single access ladder **Only me →
  In this project → Whole Space**, with Selected people as a separate explicit
  share.

### Home (`/home`) — user-level Today Command Center

Prioritizes, all cross-space with source-Space badges:
- **Needs attention** — pending proposals, assigned tasks, failed runs.
- **Review packets** — pending proposals grouped/labelled by source Space; opening enters the
  owning Space.
- **Continue working** — recent runs and participation across spaces.
- **Suggested actions** — derived from the real aggregate (never fabricated).
- **Recent timeline** — cross-space pointers.
- **Right panel** — pending review, active runs, your tasks (useful empty states).

There is **no module gallery** on Home.

Home should remain a thin UI over backend aggregate read models. Cross-space
Home data comes from `/api/v1/me/*`; space Today data comes from
`/api/v1/home/summary`. When Home needs another count, queue, or rollup, add or
extend a backend read model instead of reconstructing proposal/activity/runtime
logic by calling every domain API separately from the browser.

### Space Today (`/spaces/:spaceId/today`) — space-scoped dashboard

Mirrors Home's structure but limited to the active Space (`homeApi.summary`): today stats, the
product-loop strip (recent runs / open tasks / pending proposals), pending review with quick
accept/reject, sources, projects, providers, runtime, recent. Browsing this page
does not make its Space a write target; only an explicit Project context does.

---

## 3a. Navigation Model

Two stable tiers plus per-scene context (`src/core/navigation.tsx`, `src/components/shell/`):

- **Global Rail** (`RAIL_ITEMS`) — narrow, icon-only desktop rail of major destinations, Home
  first and stable: Home · Inbox · Library · Sources · Review · Knowledge · Shared · Tasks ·
  Projects · Agents · Settings. Collapsible/expandable. On mobile this becomes the bottom tab bar
  (`MOBILE_TAB_ITEMS`).
- **Scene Sidebar** (`SCENES`) — second-level navigation for the current scene, changes by
  scene (Inbox / Library / Review / Agents / Artifacts). Collapsible; when collapsed the expand
  handle is shown in the main header next to the scene title (e.g. "☰ Agents"). Home needs no
  scene sidebar. On mobile it becomes a horizontal tab strip. Filter scenes (Inbox)
  drive a single real, API-backed query param the page reads — no fabricated views; route
  scenes (Review / Agents / Artifacts) link real sibling routes. Review links the real
  `Proposals` and `Memory` surfaces; proposal-type filters (All / Memory / Knowledge / Code /
  Tasks) live inside the Proposals page because they are filters, not routes.
- **Knowledge has no scene.** It switches sub-areas via a lightweight in-header breadcrumb
  switcher (`Knowledge / Notes ▼`, `KnowledgeSectionHeader`) so each section owns its own
  layout — notably the backend-driven Notes collection tree, which would collide with a
  persistent section sidebar or tab strip. The Notes tree is local to the Notes section
  and is never a global nav tier; PARA is only the default initialization template.
  `Domains` (`/knowledge/domains`, focus areas) is one of these sections. It sits here
  because the app's groupings are functional — capture, knowledge, agents, dev — while a
  focus area is a life-area grouping with no fitting home yet. Resolving that is deferred
  until a second such destination exists; the placement is not a claim that a focus area
  is knowledge, and it is the reason Domains is not in `KNOWLEDGE_WORKSPACE_SECTIONS`
  (it is a parked destination, not one `/knowledge` should reopen by default).
- **Right Inspector** — scene/object-specific and owned by individual pages, never an
  app-level feature menu.

The old single mixed sidebar, the "perspective" (personal-as-Space) model, the
PersonalView-as-Space switcher entry, the module-gallery Home, the imperative
`setActiveSpace`/`activeOperationalSpace*` context API, and `location.state` navigation handoffs
(now `?open=` / `?draft=` URL params) have been removed. All navigation is URL-based.

---

## 3b. Interaction State And Refresh Policy

Frontend pages must preserve the user's local navigation context while mutations complete.

- Route-level, detail-page, settings-page, and sidebar tabs must be controlled (`value` +
  `onValueChange`), not `defaultValue`, unless the component is truly static and never
  remounts after data changes.
- A save/create/run action must not reset the active tab, selected panel, open advanced
  section, or current filter. Reset local UI state only when the entity id, route scope, or
  explicit user action changes.
- Prefer local state updates from mutation responses (`setItem`, `upsert`, append/prepend
  returned rows) over full `load()` reloads. Use a background refresh only for secondary
  read models that the mutation response cannot provide.
- Initial skeleton/loading states are for first load or route/entity changes. Refresh buttons
  and post-mutation reloads should keep existing content visible and show only local busy
  indicators.
- Tests for tabbed/detail/settings pages should cover the common regression: perform a
  mutation from a non-default tab and assert the active tab remains selected and the page does
  not re-run the full initial load unless that is intentionally required.

### Module-scoped refresh invariant

The frontend uses minimum-scope refresh as a product invariant, not only as a performance
optimization. A mutation must update the smallest data module that it can affect and must not
re-run a page-level aggregate loader as a shortcut.

- A mutation response is the first source for the updated entity: upsert it into local state,
  remove it locally when the response is terminal, and update only the affected collection.
- When a response cannot contain the complete read model, refresh the owning module only — for
  example, Project Research refreshes operations/workflows/checkpoints/artifacts, Project Sources
  refreshes bindings/health/items/corpus, and Project Folder linking refreshes Project Folder
  links and the Project Folder summary.
- Unrelated page data such as activities, memory, providers, agents, Project Folders, and other
  project summaries must not be re-requested after a mutation unless that mutation explicitly
  changes that data.
- `loadAll`/page-level loaders are reserved for first load, route/entity/space changes, or an
  explicitly requested full refresh. They must not be used as the default mutation callback.
- Background polling follows the same boundary: poll the active module's operation/read model,
  preserve existing content, and never toggle the page's initial loading state.
- New mutation callbacks should identify their affected module in their name and contract (for
  example `refreshProjectSources` or `refreshResearchState`) so a later caller cannot silently
  widen the refresh scope.

---

## 4. Module Visibility Policy

Implemented modules with backend support appear in the navigation (Global Rail and, where
applicable, the scene sidebar). There is no module gallery.

Unimplemented modules must not appear as clickable primary modules. Modules are hidden using
`enabled: false, visible: false` in the frontend module registry
(`apps/web/src/modules/registry.ts`). A module with backend prerequisites not yet met must
not be navigable.

**Current module visibility state:**

| Module | Status | Notes |
|---|---|---|
| Capture | Enabled | Functional |
| Activity Inbox | Enabled | Functional |
| Sessions | Enabled | Functional |
| Tasks | Enabled | Functional; New Task is a compact natural-language form with a few routing selectors and server-applied execution defaults. Task Detail keeps generated acceptance criteria, required outputs, policy, and metadata out of manual JSON inputs; advanced execution limits are collapsed and editable when needed. |
| Runs | Enabled | Functional; Run Detail opens on permission-filtered, runtime-neutral logical input/output and exposes semantic events, Artifact/Proposal outputs, contract, verification, routing/model provenance, retry attempts, and `waiting_for_review` Resume/Abandon actions with explicit unavailable/failure states. |
| Proposals | Enabled | Functional |
| Artifacts | Enabled | Functional |
| Shared Content | Enabled | Space-scoped targeted publication inbox/outbox at `/publications`; import creates an independent private copy. |
| Memory | Enabled | Functional |
| Job Queue | Enabled | Infrastructure debug tool |
| Files & Code | Enabled | Project-scoped Project Folder browser at `/projects/:projectId/files` (Folder selector, tree, file, Git status/diff). Its zero-Folder action opens the Project-owned managed/clone/allowed-connect flow; Folder execution/configuration and unregister live in Folder Settings, while code writes, validation evidence, apply, and rollback remain governed through Runs and code-patch Proposals rather than direct file editing. |
| Project Folder Settings | Enabled | Per-Project-Folder settings page at `/projects/:projectId/folders/:folderId`, including a Snapshot settings section that overrides `snapshot_retention_days` / `snapshot_max_count` for that Folder |
| Snapshot Rollback Defaults | Enabled | Space-admin-only section on Space Settings (`/space-settings`) configuring the space-wide `snapshot_retention_days_default` / `snapshot_max_count_default` that Project Folders inherit absent a per-Folder override |
| Retrieval Settings | Enabled | Space-scoped UI for the `retrieval.space.settings` scoped setting and retrieval `provider_task_policies` (`/retrieval-settings`); members can view retrieval models, while owner/admin users can edit default search mode, retrieval embedding dimensions/models, native rerank model, rerank/rewrite availability, rewrite/cache/trace defaults, and default result budget. Query rewrite, rerank, and synthesis prompt editing links to Prompt Library rather than duplicating prompt controls here. |
| Settings | Enabled | Functional |
| Capabilities | Enabled | Capability/skill control-plane; developer-heavy but user-visible for review |
| Prompt Library | Enabled | Space-admin prompt control plane at `/prompts`; lists prompt assets and versions, previews/evaluates immutable prompt versions, manages staging/production deployment refs, supports proposal-backed production promotion and rollback, and shows distinct prompt sets plus read-only workflow/capability usage context for auto research assets |
| Agent Plans | Enabled | `/plans` is a read/review surface for Agent-generated Plans. Plan creation and revision start from Task Detail's Ask Agent to plan action; Plan Detail shows Source Task, review Proposal, Execute, Reconcile, versions, Plan Nodes, node Runs, and root Run. No raw-definition or New Plan form exists. |
| Automations | Enabled | Space-scoped manual/scheduled Automation surface at `/automations`; supports agent runs, maintenance targets, and fixed Workflow targets with pin/follow resolution, version selection, input JSON, Run now, Pause/Resume, Archive, recent Workflow Executions, node progress, checkpoints, and root Run links. Scheduled Workflow targets are pinned. |
| Evolution | Enabled | `/evolution`; manages candidate asset versions, draft editing, direct candidate/testing transitions, Evaluation Cases, queued evaluations over existing candidate Runs, evaluation evidence, and proposal-backed Promotion. |
| Evolution Inbox | Enabled | `/evolution/inbox`; consolidates signals, all visible pending proposal evidence (including ordinary memory/code/workflow proposals), D3 bundles, evaluation evidence, and standard approval actions. Bundle decisions remain server-governed and the UI never applies proposals directly. |
| Providers | Enabled | Functional; provider cards and create/edit forms show capability labels for Chat, Embeddings, and Native rerank, and creation is split into chat-provider, embedding-provider, and rerank-provider flows so retrieval-only providers are not confused with ordinary chat providers |
| Token Usage | Enabled | Reached from personal Settings (`/settings` → Usage card) at `/usage`, visible to every active member — not a primary rail destination, since it is a lower-frequency review surface and Space Settings is admin-gated and would hide it from ordinary members. Defaults to `Mine` and supports `Shared in space` and `All visible`; all server aggregations are permission-filtered before grouping. The dashboard shows model token usage, estimated cost, accuracy, platform attribution, sessions, dimensions, read-only budget preview, and private local CLI history imports without exposing prompt or completion content. |
| Runtime (CLI Adapters) | Enabled | Functional |
| Rooms | Enabled | Project-bound conversation is a first-level Project workspace at `/projects/:projectId/rooms`, reachable from the persistent Project sidebar and Overview without leaving the Project Shell. `/rooms` is the space-scoped cross-Project Room index. Both routes render the same Room implementation and authority. A Room has one optional execution-enabled Project Folder binding, human and agent rosters, and multiple durable conversations. Each human message executes under that speaker's retrieval identity and user × session × agent backend binding, opens one auditable collaboration task, supports direct `@agent` segmentation or manager coordination, and shows paged history, active Run lifecycle/status links, plus terminal agent replies in the conversation. `/agent-groups` remains the backend task/audit authority, not a second conversation UI. There is no separate Project Chat route or default-Assistant chat entry. |
| **Home** (user-scoped) | Enabled | Cross-space command center at `/home`; **not** a Space, not in the switcher |
| **Today** (Space) | Enabled | Space-scoped dashboard at `/spaces/:spaceId/today` for the active Space |
| **Inbox** (Activity) | Enabled | Capture inputs (rail label "Inbox"; route `/activity`) |
| **Library** | Enabled | Space-scoped, per-user reading surface at `/library` for Sources-derived items and digests. `/library` is a shell that defaults to `/library/items`; scene-sidebar routes keep `All Items` and `Digests` as siblings, with soft type filters under `All Items` (`/library/items/articles`, `/library/items/emails`, `/library/items/videos`, `/library/items/podcasts`, `/library/items/pdfs`). It only shows items/digests from sources the current user follows, plus that user's manual unconnected URLs. Source digest detail routes live under `/library/digests/:connectionId/:date`; single-item readers live under `/library/items/:itemId` or the day-scoped `/library/digests/:connectionId/:date/items/:itemId`. |
| **Sources** | Enabled | Space-scoped information stream control plane at `/sources`; owns RSS/Atom/web page connections, owner/visibility metadata, opt-in delivery subscriptions, source-level health, scan state, and source governance. Pending source recommendations show source metadata and Follow/Dismiss/Mute actions without exposing the item stream until the user follows. Project item feeds do not live here. |
| **Project Sources** | Enabled | Acquisition/control surface at `/projects/:projectId/sources`; binds existing Sources, explicitly shows/selects the extraction profile and per-binding Standing switch, shows health, runs scans/backfills, pauses/removes bindings, and renders newly materialized source items. A direct binding defaults to the registered generic-document profile and Standing on. It does not own article-level corpus review. |
| **Research Area** | Enabled | Project research work at `/projects/:projectId/research`, with one five-tab surface: **Standing overview** for goal-ambiguous work and recent inflow, **Focus workbench** for Inquiry-Thread-scoped stage progression, filterable **Reading List** with triage/read and WHY/HOW/WHAT, draggable **Checklist** with agent-origin badges, and immutable **Reports** snapshots. Standing and Focus stay mounted while their tabs are inactive so switching does not discard setup drafts, selections, or either domain's state. Notes are not a Research tab; the Project-level Notes surface owns writing and notebook chat. Project Sources remains acquisition-only with a pointer to the Reading List. |
| **Project Shell** | Enabled | Every `/projects/:projectId/*` destination shares persistent grouped navigation: Project (Overview, Notes, Rooms); Explore (Inquiry, Research, Sources, Digest, Files & Code, Experiments); Decide & Learn (Decisions, Learning, Knowledge Review); Execute (Delivery, Operations). `/projects/:projectId/notes` mounts the shared Notes workspace hoisted to the Project collection, with the same editor/actions as global Notes and Project-scoped notebook chat. Every Area is served by the shell's single floating **Capture** composer: the Project shell declares the Project and an Area that knows what it is currently about declares that object (Inquiry declares its focused Thread; no other Area declares one today), which is what makes the object-marginalia destination reachable. Every destination writes an `activity_record` first; the two marginalia destinations additionally project the text into the caller's own private note in the same transaction. Notes may be shared into another Project by explicit confirmation on placement, shown and revocable from the note's `Shared` status chip. Overview is a thin aggregation layer over Areas — Brief goal and current focus, the Mode's next actions, the cross-domain Activity timeline, and one summary row per entity linking into the Area that owns it — and hosts no Area's working surface. Its four-block skeleton remains visible for empty Modes; goal edits append an immutable Brief Version and focus edits update Project presentation metadata. The setup checklist and Attention are rendered by the shell sidebar, which is on screen from every Area, and by nothing else. Primary Mode changes foreground presentation only and never hides or converts another Area's objects; zero-Folder Projects keep every Area reachable. |
| **Inquiry Area** | Enabled | Project-owned Question/Hypothesis domain at `/projects/:projectId/inquiry`, presented as three sibling views over one route and one selected Thread: **Focus** (default), **Map**, and **Review**. Focus has a navigator grouped by attention state, a Thread header, one unified stage workspace, and secondary Evidence/Relations/Notes/History tabs. The workspace is the sole owner of the derived Clarify → Acquire → Digest → Conclude → Land round: its top row is the only stage selector, and selecting a stage changes the adjacent panel without mutating backend work. Actual current, manually inspected, completed, and running stages remain visually distinct; a manual selection stays pinned through polling, while a successful action follows the newly derived current stage. Each panel explains the stage purpose and completion condition and contains only that stage's actions. One `Suggested next` surface remains visible above it: valid open non-stale model Advice occupies it, otherwise a deterministic state-grounded fallback does, without asking users to distinguish “AI” from “system” advice. Ignoring model Advice dismisses it and reveals the fallback; stale Advice and manual re-analysis controls are absent. Starting a suggestion or alternative writes the Step through the existing work command and navigates to the owning Area; Acquire and Land retain their legitimate in-stage alternatives. A blocked workspace stays readable with actions disabled and an explicit Unblock that clears no Step. Normal round close-out appears in Land; pause, block, early close-out, lifecycle, priority, owner, and personal-Focus commands live in the Thread menu. Running background work is named without replacing guidance. While work is live the page polls Inquiry, Research Workflow, and Advice reads every five seconds, refreshes after local mutations and on visibility return, and installs no interval for idle Threads; model generation remains server-side and event-driven. Refresh demand is coalesced per Project/Thread and responses are identity-fenced, so an older read cannot overwrite a newly selected Thread; transient Research read failures preserve the last successful live-work snapshot, and polling does not discard an in-progress wording edit. Every Area that owns a Step's work renders a thin origin bar naming the Thread that sent the user there. Map shows the primary-parent structure and relation graph; Review owns Delta Brief and bounded Candidate review. Research-question assessment remains the dedicated `/projects/:projectId/inquiry/:threadId/assess` two-pane conversation/framework route: volatile edits require explicit confirmation, confirmed snapshots and wording revisions remain immutable history, and the model never becomes write authority. |
| **Experiments Area** | Enabled | `/projects/:projectId/experiments`; manages Definitions, immutable protocol Versions, manual and managed comparison Runs, Observations, reviewed Interpretations, and explicit conversion to Inquiry Signals. Managed setup selects an execution-enabled Folder and active Agent by name; the Agent carries the governed runtime profile. Terminal reconciliation returns status and parsed metrics to the Experiment Run. |
| **Decisions Area** | Enabled | `/projects/:projectId/decisions`; creates standalone or explicitly Inquiry-linked Decision Cases, shows named Thread references, manages Options, Criteria, trade-off scores, Commitments, and explicit Delivery Tasks. |
| **Learning Area** | Enabled | `/projects/:projectId/learning`; searches and selects visible Project/global Knowledge by title and version, creates Project learning objectives and version-pinned cards/exercises, then records per-user review outcomes. |
| **Project Knowledge Review** | Enabled | `/projects/:projectId/knowledge-review`; summarizes new source information, selects eligible Notes/Threads/Interpretations and Agents by name for extraction, opens bounded Candidate checkpoints, supports view-all, edit-and-promote, defer/reopen, and dismiss. Canonical Knowledge writes remain proposal-gated. |
| **Delivery Area** | Enabled | `/projects/:projectId/delivery`; an ACL-filtered Project Task view supporting create, named Agent/self assignment, start, complete, reopen, and exact Task Detail links through the Task authority. It does not create a separate Delivery object model. |
| **Operations Area** | Enabled | `/projects/:projectId/operations`; composes Project Operations, Automations, visible governed Runs, and project-scoped `operational_alert` Activity. Attention query selection highlights the exact operation/alert; Automation pause/resume/run-now and Run Detail links preserve owning authority. Active/waiting, review, degraded fallback, terminal failure, and archived Project states are distinct. No Incident aggregate is implied by this projection. |
| **Review** (Proposals + Memory) | Enabled | Governance area (rail label "Review"; routes `/proposals` and `/memory`). The scene sidebar links real surfaces; proposal-type filters live inside `/proposals`. |
| **Knowledge** | Enabled | First-level unified module (rail label "Knowledge"; route `/knowledge`). `/knowledge` redirects to the last-used section (default `/knowledge/notes`); `/knowledge/home` is an optional overview hub, never the forced landing. Sub-areas switch via an in-header breadcrumb (no scene sidebar): **Notes** (working-knowledge Area — configurable collection tree + open-note tabs), **Wiki** (canonical, KnowledgeItem-backed, `/knowledge/wiki`), **Sources** (backend source CRUD exists; current frontend is list-only evidence browsing), **Cards**. The note editor's link picker offers every object type that is both linkable and searchable — Note, Wiki, Source, Claim, Question — built from `NOTE_LINK_TARGET_TYPE_VALUES` rather than a hand-maintained array, and guarded by `server/test/noteLinkTargetsGuard.test.ts`. Candidates for the search-backed kinds come from `POST /api/v1/knowledge/search`. `note_links` stays navigational and carries no graph authority (N4). The reverse direction is a "jot a note" action on Research Area reading-list cards: `POST /api/v1/knowledge/notes/jot` creates (or appends to) a note and records the link in one call, and `GET /api/v1/knowledge/objects/:objectId/note-links` answers what notes cite a given object. Jotting is offered only on rows with an `object_id` — a corpus row's `source_item_id` / `evidence_id` targets have no `space_objects` row and cannot be a link endpoint. |
| **Graph** | Enabled | Space-scoped relationship projection at `/graph`; renders the shared `GraphProjection` contract through `apps/web/src/components/graph/`, reads core `/api/v1/graph/*`, persists per-user view state under `scope_key='core:graph'`, `core:graph:<lens_id>`, `project:graph:<project_id>`, or `project:graph:<project_id>:<lens_id>`, and remains read-only over visible `space_objects` / `object_relations`. `?project_id=` narrows the graph to active object-backed Project corpus rows; `?lens_id=academic_citation_v1` applies the academic citation/authorship lens. |
| **Cards** | `enabled: false, visible: false` | Standalone module hidden; surfaced as the Knowledge › Cards placeholder until the spaced-repetition model exists |
| Time | `planned: true` | Shows "soon" badge |

Future modules (Editor, Calendar, Automation, and domain-specific graph surfaces beyond the
core Graph page) should only be enabled when backend support exists. Do not add them to the
registry as clickable modules before that.

---

## 5. Error and Empty-State Policy

### Authentication

- 401 dispatches the `auth:required` event → `RequireAuth` redirects to `/login`.
- Per-page auth errors should show "Session expired — sign in again" before redirect.

### 404 / Not Accessible

- 404 for any durable object must render as: **"Not found or not accessible"**
- Do not reveal whether the object exists in another space.
- Do not show raw server error text.
- Show a contextual empty state with a back link, not a toast.

Affected pages: Sessions detail, Task detail, Activity detail, Run detail.

### Empty States

| Surface | Empty-state guidance |
|---|---|
| Activity Inbox (raw) | "Nothing to process. Use Quick Capture to save a thought." → link to Capture |
| Proposal Inbox | "No pending proposals. Process activity or ask an agent to generate some." |
| No runtime configured | "No runtime adapter configured." → link to Runtime settings |
| No recent sessions | "Start by asking an agent or capturing a thought." |
| Unsupported proposal type | "This proposal type cannot be applied yet. Reject to dismiss it." |
| Hidden task (404) | "This task is not accessible in your current space or visibility level." |
| Board with filtered tasks | Note: "Tasks filtered by your visibility in this space. Some board items may not be shown." |

### Proposal Accept/Reject

Errors on proposal accept/reject must distinguish:
- Unsupported proposal type → friendly explanation, not raw 422
- Egress approval required → handled by the `EgressReviewNotice` component

---

## 6. Current Frontend Status

The frontend is ready for personal dogfooding. The core product loop is usable:
- Capture → Activity Inbox → Consolidate → Proposals → Accept/Reject → Memory/Task
- Sessions, Runs, Artifacts, Memory, Project Folders, Settings are functional.
- Normal product forms resolve Projects, Project Folders, Agents, runtime
  profiles, Runs, Artifacts, Knowledge Items, and graph roots through named or
  contextual choices. They do not request internal UUIDs. Diagnostic workflows
  that genuinely require an opaque identifier use an explicitly collapsed
  technical-details control; detail pages keep copyable provenance identifiers
  behind the same kind of affordance.
- A static frontend test scans user-facing labels, placeholders, and accessible
  labels so new raw `ID`/`UUID` inputs cannot silently return to normal flows.
- Auth, space context, and RequireAuth wrapper are correctly wired.
- Project creation asks how the work advances (Primary Mode) and captures Name,
  Goal, and Scope; the server atomically creates the Project, its initial Mode
  Transition, and the first Brief Version. It binds no Sources and presets
  nothing else. Later Primary Mode changes only change presentation/focus
  without moving or deleting any Area's data. Academic research is a set of
  Sources and an extraction profile, not a Project type: every Project's
  research surface defaults to the standing research panel and offers the
  Thread-scoped focus workbench as a sibling view; the separate
  Research Area owns Reading List, Checklist, and Reports. Runtime profile
  selection is hidden when an Agent has only one enabled default runtime.
  Project pages show compact Sources summaries and recent Sources
  recommendations, then hand off project collection work to
  `/projects/:projectId/sources`; global source-level management remains
  `/sources`. The
  Capabilities page is the imported skill/package review surface. Library (`/library`)
  is the shell for per-user Sources-derived reading, with scene-sidebar routes
  for All Items and Digests; item type filters live under All Items rather than
  becoming top-level Library categories. Activity Inbox daily source rows point
  into `/library/digests/:connectionId/:date`, source recommendation rows point
  into `/sources?view=pending`, and project source collection rows point into
  `/projects/:projectId/sources`; Inbox does not render source item or digest
  bodies.
  Artifacts render structured Research outputs when possible.

**Non-blocking follow-ups (discovered during use):**

- ✅ **Done:** Space-scoped routes are now URL-scoped (`/spaces/:spaceId/*`) and deep-linkable;
  the active Space is read from the route, and all in-app navigation is URL-based (no
  `location.state` handoffs). Accessing a Space the user can't see falls back to the preferred
  Space. (Backend access control is the source of truth — a shared-Space URL is only viewable by
  its members; non-members get the standard authz error, not silent space-switching.)
- Cross-space Home aggregates are limited to what `/me/*` exposes (proposals, tasks, runs,
  participation, timeline). "Captures waiting" / "review packets ready" / "cards due" per Space
  need backend aggregate endpoints before they can appear on Home; the frontend should not fan
  out across raw domain APIs to reconstruct those counts.
- Capture supports text and links; file/image drag-drop and voice are shown as
  coming-soon (no upload endpoint yet).
- Home has no Assistant chat entry; project-bound conversation lives only in
  the Rooms surface.
- Activity / Run / Artifact cross-linking can be improved (e.g., post-consolidate navigation
  to generated proposals; post-accept link to created memory record).
- Board visibility notice can be added before heavier shared-space use.

These are improvements to collect from real use, not pre-conditions for dogfooding.

---

## 7. Backend Security Boundaries the Frontend Must Respect

### Space oversight and disclosure upgrades

The create-Space form exposes the immutable `none` / `summary` / `content` /
`full` oversight choice with plain-language descriptions and an explicit
"cannot be changed" notice. Space Settings displays the chosen mode read-only.
The mode is included in every member's Space DTO, not hidden behind an admin
surface. When editing a private or `selected_users` content policy in a Space
whose mode is not `none`, `ContentAccessControl` keeps a persistent oversight
hint visible. For `space_shared` content at summary level, the same control
offers a member picker for per-user `full` disclosure upgrades; it does not
offer grants at full base level because grants never narrow disclosure.

| Backend rule | Frontend implication |
|---|---|
| All data routes require `get_identity` | Every data call inside `RequireAuth`; 401 event dispatched by `client.ts` |
| Sessions are user-owned within a space; cross-space access → 404 | Sessions detail must treat 404 as "not accessible" |
| Task visibility: private or ungranted selected-user tasks return 404 on direct access | Task detail shows "not accessible" empty state |
| Board task list is filtered by visibility | Board view should indicate filtered content is possible |
| Activity process/consolidate enforces visibility | Same 404 handling in Activity detail |
| Proposals: accept/reject → 422 for unsupported types | Proposals page distinguishes unsupported-type errors |
| Egress approval is a cross-space exception | Handled by `EgressReviewNotice` component |
| Publications expose immutable target snapshots, never live source reads | Shared Content previews the snapshot and opens only imported copies |
| Space oversight is read-only, creation-time immutable, and transparent to every member | Creation form explains the four modes; Space Settings is read-only; private/selected policies show the active oversight hint |
| `space_shared` grants can widen disclosure from summary to full | Content access editor labels the picker as a disclosure upgrade and sends its per-member grant levels |
| Cross-person reads are owner-visible privacy audit | The content access editor exposes the selected resource's log only to its owner; admins do not get a query bypass |
| Demotion cannot retract prior exposure | A shared-to-narrower save first renders linked readers, consuming Runs, and still-shared derived outputs; only a second explicit confirmation submits the demotion |
| Raw activity is not memory — it is input awaiting processing | Labels reflect this: Activity Inbox = captured input |

---

## 8. Orchestration and evolution command paths

The clickable dogfooding path is intentionally structured rather than canvas-based:

- `/tasks` → New task (natural-language goal + optional selectors) → Task Detail → Ask Agent to plan or create queued run → `/runs/:id`.
- `/tasks/:taskId` → Ask Agent to plan → planning Run → current Plan/Plan
  Detail → pending `plan_review` Proposal → Execute approved Plan → root Run →
  Reconcile. `/plans` is the cross-Task review index for this flow.
- `/automations` → Workflow target → template/version/resolution/input → Run now
  or schedule → Workflow Execution → child Runs/checkpoint → root Run; the
  backend revalidates all asset and policy constraints and never creates a
  Plan.
- `/evolution` → select asset → Create candidate version → Candidate/Testing →
  Evaluation Case → existing candidate Run evaluation → Promotion Proposal →
  `/evolution/inbox` approval.
- `/runs/:id` → `waiting_for_review` → Resume or Abandon; abandon requires no
  database-side recovery and is terminal.

These surfaces use structured forms plus Advanced JSON for extensibility. The client
does not apply proposals or infer approval; all mutations go through the server authority.

## 9. Future Modules — Prerequisites Before Enabling

| Module | Backend prerequisite |
|---|---|
| Cards | Spaced-repetition card model + review API |
| Time | Time entry model + activity linkage |
| Editor | File editor backend + save API |
| Calendar | Calendar/scheduling model |
| External Automation triggers | Trigger registry, webhook/cron ownership, policy, budget, and credential model |
| Knowledge Graph | Graph query API |
