# Plan 3 — PhD Application Plugin (Pilot)

Status: not started. Depends on [plan 2](02-plugin-operation-platform.md).

## Goal

Ship the first plugin written entirely on the new contract. It validates the
operation core and the plugin platform end to end, and it is the product entry
for PhD applicants: their application work accumulates as reusable context in
Rainver's core objects, which later Projects (starting a PhD, research) reuse.

## Product shape

The plugin mounts a **PhD application Area** inside an ordinary Project and sets
it as that Project's default landing. It is not a Project type: generic Areas
remain reachable, collapsed.

| View | Content |
|---|---|
| Application overview (main) | One row per application: deadline, materials completion, outreach status, result |
| Timeline | Deadlines on a calendar |
| Supervisor outreach | Contact history, reply status, next step per supervisor |
| Materials | Master CV/SoP and per-application tailored versions |
| Opportunity inbox | Opportunities pushed from discovery, one click to an application (discovery integration is in [later extensions](06-later-extensions.md)) |

## Data split

| Lives in | Content | Why |
|---|---|---|
| Core objects (via host ports) | Background, research interests, goals (Memory, through proposals) | Reused by later Projects |
| | Supervisors, universities, referees (Relations) | Supervisors stay relevant after admission |
| | CV, SoP, outreach email versions (Artifacts) | Reused for papers and job search |
| | Deadlines and to-dos (Tasks) | Generic capability |
| | Agent conversation (Project Room) | Generic capability |
| Plugin schema `plugin_phd_apply` | Application record (university × program × supervisor, deadline, status pipeline, requirement checklist, result) | Domain-specific structure |
| | Opportunity reference (pointer to an external opportunity) | Domain-specific |

Check: with the plugin disabled, supervisors, documents, background and tasks are
all still present and useful.

## Operations (first cut)

| Operation | Side effects | Note |
|---|---|---|
| `plugin.phd_apply.application.list` / `.get` | none | |
| `plugin.phd_apply.application.create` | durable | Reversible |
| `plugin.phd_apply.application.update_checklist` | durable | |
| `plugin.phd_apply.application.update_status` to submitted / offer accepted | proposal | Consequential status change |
| `plugin.phd_apply.outreach.log` | durable | |
| `plugin.phd_apply.outreach.send_email` | proposal | External send always approved by a person |

All data is `data_class: normal`. The UI uses only `/api/v1/actions` and
`/api/v1/queries`; the plugin registers no data routes.

## Work items

- [ ] Manifest, migrations in `plugin_phd_apply`, operations above.
- [ ] Core-object references through host ports (Relations, Artifacts, Tasks).
- [ ] Area slot views: overview, timeline, outreach, materials, inbox (empty until discovery).
- [ ] Optional bundled Skill describing the PhD application method; procedural
  content only, grants nothing.
- [ ] Acceptance: the same create/update performed from the UI and by an Agent in
  the Project Room produces identical records, one policy decision each, and the
  same audit; disabling the plugin fails every entry closed; core objects survive disable.
- [ ] Visual acceptance of the Area in its parent Project surface per
  [UI_STYLE_GUIDE](../../architecture/UI_STYLE_GUIDE.md).

## Out of scope

- Pulling opportunities from phd_detect (later extensions).
- The "offer accepted → start PhD research Project" transition (later extensions).
- Any public sign-up or acquisition flow.
