# Applications Plugin Plan

Delivered to the repository: stage 1 (Project-level
plugin contract, persistent Project binding and operation-core integration),
stage 2 (the bundled application management package), stage 3 (materials in
Notes: links, reviewed versions, source pins, draft generation and the Area's
material view) and the four-area revision — one *Applications* entry in the
Project with program applications grouped by institution, scholarships and
funding (the `funding` track, migration `0003_funding_library_contact_links.sql`,
submission history in `0004`/`0005`), the material library (`web/src/libraryTab.tsx`)
and supervisors and contacts (`web/src/contactsTab.tsx`).
A separate new-product pilot, not unfinished core entry infrastructure or
legacy migration. Uses the plugin operation platform and the typed host ports and permission gates of
[ADR 0030](../decisions/0030-plugin-agent-data-access.md). Current behaviour lives in
[Project binding](../architecture/OFFICIAL_OPTIONAL_MODULES.md#project-binding)
and [PhD Application package](../architecture/OFFICIAL_OPTIONAL_MODULES.md#phd-application-package);
this plan keeps only the remaining work.

Direction agreed 2026-11-18: one Project-level *application management*
package with PhD application as its first track and scholarship/funding as its
second; a job track would reuse the same records and operations as another
configuration entry. Application records belong to the Project they are
bound to; reusable CV, experience and statement text stay in Notes and other
core objects and are referenced, so unbinding or disabling the package never
removes them.

## Stages

| Stage | Scope | Status |
| --- | --- | --- |
| 1. Project-level platform | Manifest `project_binding`, binding table and person-only bind/unbind/list operations, host Project gate on every entry (Agent Run Project, Project ACL, replay, proposal apply, release), core-port confinement, binding-aware Project entries and settings card, unbind/disable retention | Implemented |
| 2. Application domain package | `plugins/official/phd_application/` (PhD first track): records, multiple deadlines, checklist, progress/results, approved decisions, contacts and contact events, opportunity source; Project Area and overview card; Tasks and references through core ports; real-PG and Chromium acceptance | Implemented |
| 3. Materials and Notes | Text materials in Notes linked to application requirements; reviewed generation | Implemented: Notes links, revision reads, reviewed versions, source pins through the `notes.read` port, [generated drafts](../architecture/OFFICIAL_OPTIONAL_MODULES.md#generated-drafts) (private Run over pinned versions, preview, save through the Note writer with `expect_version`, `notes.draft` port) and the Area's material view |
| Four-area revision | One *Applications* entry with four tabs: program applications grouped by institution, scholarships and funding (`funding` track with `submission: separate\|automatic` and funding links), material library over Notes, supervisors and contacts linked to applications; submission history guard | Implemented |

Stage 2 resolved: package `phd_application` ("PhD Application", PhD as
first track); application/deadline/material operations `non_sensitive` (ADR 0030
mapping), contacts and contact events `personal`; deadlines become core Tasks
only on request. New application records are visible to Project readers and
edits use the record owner's authority. Contacts and outreach history use
individual visibility.

Remaining (each needs its own authorization):

- Follow-ups (not scheduled): a Note picker instead of ids when adding to the
  material library (`libraryTab.tsx` takes a typed `note_id`). The earlier
  new-Note placement exception was removed: a new Note follows the creation rule
  (only in a Personal Space), and a shared Space saves only into a linked Note no
  one else, oversight included, reads — see
  [Generated drafts](../architecture/OFFICIAL_OPTIONAL_MODULES.md#generated-drafts).
- Deferred by direction: templates, PDF/Word export, any send or submit,
  automatic opportunity intake from discovery.
- Implemented 2026-11-21, privately saved and not deployed: automatic updates of
  existing applications from new Gmail mail
  ([ADR 0034](../decisions/0034-gmail-application-updates.md); external facts only, the
  person's decisions stay proposals). Live acceptance with a real mailbox remains open
  ([deferred register](../tasks/deferred-register.md#gmail--real-environment-acceptance-and-limits)).
- Open product decisions: Relations people/organizations (Relations person creation is user-only,
  organizations have no port); a timeline/calendar view; default landing
  Area, Project-scoped Jobs/holds and cross-Project views only on demonstrated need.
- Deployment of the package uses the stopped-writer maintenance path
  (`maintenance-pending` reports it); not authorized here.

## Goal

Ship the first plugin written entirely on the new contract. It validates the
operation core and the plugin platform end to end, and it is the product entry
for PhD applicants: their application work accumulates as reusable context in
Rainver's core objects, which later Projects (starting a PhD, research) reuse.

## Product shape

The plugin mounts a **PhD application Area** inside an ordinary Project it is
bound to (stage 1 binding), optionally later as that Project's default landing. It is not a Project type: generic Areas
remain reachable, collapsed.

| View | Content |
|---|---|
| Application overview (main) | One row per application: deadline, materials completion, outreach status, result |
| Timeline | Deadlines on a calendar |
| Supervisor outreach | Contact history, reply status, next step per supervisor |
| Materials | Master CV/SoP and per-application tailored versions |
| Opportunity inbox | Opportunities pushed from discovery, one click to an application (discovery integration is in [later extensions](plugin-platform-extensions-plan.md)) |

## Data split

| Lives in | Content | Why |
|---|---|---|
| Core objects (via host ports) | Background, research interests, goals (Memory, through proposals) | Reused by later Projects |
| | Supervisors, universities, referees (Relations) | Supervisors stay relevant after admission |
| | CV, SoP, outreach email versions (Artifacts) | Reused for papers and job search |
| | Deadlines and to-dos (Tasks) | Generic capability |
| | Agent conversation (Project Room) | Generic capability |
| Plugin schema `plugin_phd_application` | Application record (university × program × supervisor, deadline, status pipeline, requirement checklist, result) | Domain-specific structure |
| | Opportunity reference (pointer to an external opportunity) | Domain-specific |

Check: with the plugin disabled, supervisors, documents, background and tasks are
all still present and useful.

## Operations

Implemented operations, classes and refusals are in the
[owner guide](../architecture/OFFICIAL_OPTIONAL_MODULES.md#phd-application-package).
Still open from the first cut: an outreach send (`send_email`, always a
person-approved proposal) only once a governed send capability exists.

## Work items

- [x] Project binding platform (stage 1): bindings, host gate, entries, settings.
- [x] Manifest with `project_binding: 'required'`, migrations in `plugin_phd_application` keyed by Space, person and Project, operations as documented in the owner guide.
- [x] Core-object references through host ports (Tasks, Artifacts/Tasks references). Relations not used.
- [x] Area and overview views (applications with deadlines, checklist, progress, decisions, contacts). Timeline view and opportunity inbox remain open.
- [ ] Optional bundled Skill describing the PhD application method; procedural
  content only, grants nothing (not started).
- [x] Acceptance: the same create performed from the UI and by an Agent in
  the Project Room produces identical records, one policy decision each, and the
  same audit; disabling the plugin fails every entry closed; core objects survive disable.
- [x] Visual acceptance of the Area in its parent Project surface per
  [UI_STYLE_GUIDE](../architecture/UI_STYLE_GUIDE.md) (pending reviewer inspection).

## Out of scope

- Pulling opportunities from phd_detect (later extensions).
- The "offer accepted → start PhD research Project" transition (later extensions).
- Any public sign-up or acquisition flow.

## PhD Application rename and single-instance cutover

Completed. The package now uses the `phd_application` ID and the
**PhD Application** display name. The maintainer confirmed the production
cutover and observed a subsequent Gmail automation update. See the
[migration history](../../server/migrations/README.md#phd-application-migration-history).
