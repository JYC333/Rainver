# Module: Relations

## Status
**IMPLEMENTED** - core people, organizations, identities, affiliations, notes,
source links, and academic paper object extensions are implemented as
server-owned modules.

## Purpose
Relations is the reusable relationship data foundation for Rainver. It owns
people and organization records, identity handles, affiliation edges, and
provenance links that can be used by normal life, team, and research workflows.

Academic research is a set of Sources and an extraction profile layered on these core modules. It is not a
separate plugin, not a second Project hierarchy, and not a top-level product
route. Academic-specific paper metadata lives in the `academic` module and
connects to the same `space_objects` / `object_relations` graph used by the rest
of the system.

## Backend Ownership

The registered backend modules are:

| Module | Routes | Ownership |
|---|---|---|
| `relations` | `/api/v1/relations*` | People, organizations, identities, affiliations, relation notes, and relation source links. |
| `academic` | `/api/v1/academic*` | Academic paper metadata, paper authorship edges, and paper citation edges. |

Relations writes object-backed records through the shared object model:

- Direct person, organization, and academic-paper creation uses the shared
  access creation resolver. Context-free records land private in Personal
  Space; a Project creation is shared, Project-scoped, and written only after
  Project writer authorization.

- `relation_people` extends `space_objects` rows whose `object_type` is
  `person`.
- `relation_organizations` extends `space_objects` rows whose `object_type` is
  `organization`.
- `academic_papers` extends the existing `sources` object extension for papers;
  papers are not a new `space_objects.object_type`.
- Affiliations, authorship, and citations are proposed through the Knowledge
  proposal path. Only proposal acceptance materializes their canonical
  `object_relations` edge; structured affiliation/author metadata lives in the
  edge's `metadata_json`, so there is no domain-table dual write. The proposal
  applier validates relation-type-specific metadata (including affiliation
  timestamps and authored-by position/boolean fields) before canonical write.
  It also validates typed endpoints: `affiliated_with` is person → organization
  and `authored_by` is source → person. Domain readers join those subtype tables
  rather than treating an arbitrary object edge as a valid typed relation.

The module owns these Drizzle-authored tables in `server/src/db/schema/`:

- `relation_people`
- `relation_organizations`
- `relation_identities`
- `relation_notes`
- `relation_source_links`
- `academic_papers`

## Boundaries

Relations does not own:

- Project selection, Project Sources, or Project corpus membership. Those stay
  with `projects` and `sources`.
- Graph rendering. Relations and Academic create graph-readable objects/edges;
  `graph` owns projection and view-state routes.
- Memory writes. Relationship facts that should become memory must still go
  through proposal-gated memory workflows.
- CRM pipeline semantics, sales workflows, or contact task automation.
- Plugin install/enablement. Academic research is exposed through a Project
  Profile, not through an official plugin.

## Project And Academic Workflow

The `academic_paper_v1` extraction profile reuses:

- Project Sources for source monitoring and item collection;
- Project Corpus for the project-specific set of collected papers, evidence,
  and related graph objects;
- Relations for people and organizations;
- Academic for paper metadata and citation/authorship links;
- Graph with `lens_id=academic_citation_v1` for the project citation/relation
  view.

The Profile may tune creation defaults and labels for academic work, but the durable
data model remains the normal Project + Sources + Relations + Graph model.

## API Shape

Current Relations routes include:

- `POST /api/v1/relations/people`
- `GET /api/v1/relations/people`
- `GET /api/v1/relations/people/:objectId`
- `PATCH /api/v1/relations/people/:objectId`
- `DELETE /api/v1/relations/people/:objectId`
- `POST /api/v1/relations/organizations`
- `GET /api/v1/relations/organizations`
- `GET /api/v1/relations/organizations/:objectId`
- `GET /api/v1/relations/search`
- `POST /api/v1/relations/:objectId/identities`
- `GET /api/v1/relations/:objectId/identities`
- `DELETE /api/v1/relations/identities/:identityId`
- `POST /api/v1/relations/affiliations`
- `GET /api/v1/relations/affiliations`
- `POST /api/v1/relations/affiliations/:affiliationId/end`
- `POST /api/v1/relations/:objectId/notes`
- `GET /api/v1/relations/:objectId/notes`
- `POST /api/v1/relations/:objectId/source-links`
- `GET /api/v1/relations/:objectId/source-links`

Current Academic routes include:

- `POST /api/v1/academic/papers`
- `GET /api/v1/academic/papers`
- `GET /api/v1/academic/papers/:objectId`
- `PATCH /api/v1/academic/papers/:objectId`
- `POST /api/v1/academic/papers/:objectId/authors`
- `GET /api/v1/academic/papers/:objectId/authors`
- `POST /api/v1/academic/papers/:objectId/citations`
- `GET /api/v1/academic/papers/:objectId/citations`
- `GET /api/v1/academic/papers/:objectId/cited-by`

## Testing

Use real-Postgres tests for schema/FK/constraint behavior:

- `server/test/relationsDb.test.ts`
- `server/test/academicDb.test.ts`
- `server/test/projectCorpusGraph.test.ts`

Use route/service unit tests for route contracts and authorization where a fake
service is sufficient.

## Related Files

- `server/src/modules/relations/`
- `server/src/modules/academic/`
- `server/src/db/schema/relations.ts`
- `server/src/db/schema/academic.ts`
- `server/src/modules/projectProfiles/`
- `server/src/modules/graph/`
- `.agent/architecture/PROJECTS.md`
- `.agent/modules/graph-view.md`
