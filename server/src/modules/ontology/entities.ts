/**
 * The entity registry and its interface declarations.
 *
 * ADR 0012 decision 6. Before this, participation in a cross-cutting mechanism
 * was recorded in three unrelated places at incompatible granularity:
 * `CONTENT_RESOURCE_DEFINITIONS` (14 entries, table-level, with a `publishable`
 * flag), the `retrieval_object_type` enum (9 entries, subtype-level), and
 * `GraphProjectionRepository`'s hardcoded assumption that only
 * `space_objects` / `object_relations` exist. Nothing could cross-validate them,
 * because they were not even describing the same units, so every new domain had
 * to be added to each by hand with no mechanism to catch an omission.
 *
 * The subject here is an **Entity**, not only an ontology object. `run`,
 * `proposal`, `artifact`, `task`, and `memory_entry` are entities too — which is
 * why unification never required a domain to become a `space_objects` row.
 *
 * **Declaration granularity is chosen by the interface, not fixed globally.**
 * `ContentAccessible` is declared once on `space_object` and inherited by every
 * subtype, because the read gate reads root-table columns; splitting it per
 * object type would fragment a registry that is correctly unified today.
 * `Retrievable` is declared per object type, because retrieval policy and
 * adapters genuinely differ per subtype. Inheritance walks `rootEntity`.
 */

/**
 * Where a resource's *additional* Project scopes live (U9).
 *
 * `projectColumn` is governance ownership and single-valued; this names a table
 * that widens the scope half of the read predicate with further Projects. It is
 * a declaration rather than a notes-only clause because the registry exists to
 * stop each domain writing its own access predicate (B12G) — and because the
 * read gate works at `space_objects` granularity, one declaration serves every
 * ontology subtype.
 *
 * Only identifiers are named here. The registry composes the SQL, so no caller
 * ever passes a fragment.
 */
export interface ContentProjectShareDeclaration {
  tableName: string;
  /** Column holding the shared resource's id. */
  resourceColumn: string;
  /** Column holding the Project the resource is additionally readable in. */
  projectColumn: string;
  /** Column set when a share is withdrawn; a set value excludes the row. */
  revokedColumn: string;
}

export interface ContentAccessibleDeclaration {
  /**
   * The identifier used by the content-access layer, when it differs from the
   * entity type. `content_access_grants.resource_type` stores this string, so
   * it is a separate identifier with data behind it, not a synonym.
   */
  resourceType?: string;
  tableName: string;
  ownerColumn: string;
  projectColumn?: string;
  projectFolderColumn?: string;
  /** JSON column whose `context_taint` member constrains publication. */
  contextTaintColumn?: string;
  /**
   * Additional Project scopes. Absent for every resource that has no sharing
   * story — and absent means the term is *not emitted*, not emitted as false,
   * so an undeclared resource's predicate is byte-identical to before.
   */
  projectShare?: ContentProjectShareDeclaration;
  /** Predicate that excludes rows the gate should treat as gone. */
  activePredicate?: (alias: string) => string;
  /** Whether this entity may be published into another Space. */
  publishable: boolean;
}

export interface EntityDefinition {
  entityType: string;
  /** Inherit interface declarations from this entity when absent here. */
  rootEntity?: string;
  contentAccessible?: ContentAccessibleDeclaration;
  /** Declared per object type: retrieval policy differs by subtype. */
  retrievable?: boolean;
  graphable?: boolean;
  /** May be referenced by `claim_sources` as evidence. */
  evidenceable?: boolean;
  /**
   * May enter Runtime Context. Carries the token stored in
   * runtime-context source-reference types, which are separate identifiers with
   * rows behind it — `activity` is stored as `activity_record`, `memory_entry`
   * as `memory`.
   */
  contextIncludable?: { itemType: string };
  /** May generate a spaced-repetition card; carries the stored `cards.source_type`. */
  cardSourceable?: { sourceType: string };
  /**
   * May be named as where a durable statement came from, in
   * `provenance_links.source_type`. Carries the stored token, which differs
   * from the entity type for `memory_entry` (stored `memory`) the same way the
   * context and card tokens do.
   */
  provenanceSourceable?: { sourceType: string };
  /**
   * Where this object type keeps its domain status, for polymorphic readers.
   * Declared rather than hardcoded so a new domain cannot be forgotten by the
   * shared status helper — which is exactly how Inquiry Threads first vanished
   * from the generic graph projection.
   */
  domainStatus?: { table: string; column: string };
  /** Canonical writes go through the proposal flow. */
  governed?: boolean;
  /**
   * The object belongs to a Project and must carry `primary_project_id`.
   * B12H: the content-access scope predicate treats a null Project as "no
   * Project restriction", so omitting it widens access rather than narrowing.
   */
  requiresProjectScope?: boolean;
  owner: string;
}

const registry = new Map<string, EntityDefinition>();

export function registerEntity(definition: EntityDefinition): void {
  const existing = registry.get(definition.entityType);
  if (existing && existing.owner !== definition.owner) {
    throw new Error(`Entity ${definition.entityType} already registered by ${existing.owner}`);
  }
  registry.set(definition.entityType, definition);
}

export function entityDefinition(entityType: string): EntityDefinition | null {
  return registry.get(entityType) ?? null;
}

export function registeredEntities(): readonly EntityDefinition[] {
  return [...registry.values()];
}

/**
 * The `content_access_grants.resource_type` key an entity is gated under.
 *
 * Not the entity type: a `space_objects` subtype inherits the root's
 * declaration, so an Experiment is gated as `space_object`. Callers that
 * guessed the entity type got "Unknown content resource type" at runtime.
 */
export function resolveContentResourceType(entityType: string): string | null {
  let current = registry.get(entityType);
  const seen = new Set<string>();
  while (current) {
    if (current.contentAccessible) {
      return current.contentAccessible.resourceType ?? current.entityType;
    }
    if (!current.rootEntity || seen.has(current.rootEntity)) return null;
    seen.add(current.rootEntity);
    current = registry.get(current.rootEntity);
  }
  return null;
}

/** Resolves a declaration through `rootEntity`, so subtypes inherit. */
export function resolveContentAccessible(entityType: string): ContentAccessibleDeclaration | null {
  let current = registry.get(entityType);
  const seen = new Set<string>();
  while (current) {
    if (current.contentAccessible) return current.contentAccessible;
    if (!current.rootEntity || seen.has(current.rootEntity)) return null;
    seen.add(current.rootEntity);
    current = registry.get(current.rootEntity);
  }
  return null;
}

function entitiesImplementing(
  predicate: (definition: EntityDefinition) => boolean,
): readonly string[] {
  return registeredEntities().filter(predicate).map((definition) => definition.entityType);
}

/** Domain status locations for polymorphic readers, in registration order. */
export function domainStatusSources(): readonly { table: string; column: string }[] {
  return registeredEntities()
    .map((definition) => definition.domainStatus)
    .filter((value): value is { table: string; column: string } => Boolean(value));
}

/** Entity types the graph projection may render as nodes. */
export function graphableEntityTypes(): readonly string[] {
  return entitiesImplementing((definition) => definition.graphable === true);
}

export function retrievableEntityTypes(): readonly string[] {
  return entitiesImplementing((definition) => definition.retrievable === true);
}

/**
 * Entity types that are `space_objects` subtypes.
 *
 * This is what `note_links` can actually reach: both its endpoints are
 * resolved against `space_objects`, so an entity without a root row — a
 * `source_item`, an `extracted_evidence`, a `memory_entry` — cannot be linked
 * however wide the storage column's type is. The note editor's target list is
 * derived from this rather than hand-maintained, because the hand-maintained
 * version is precisely what drifted from the backend before.
 */
export function spaceObjectSubtypes(): readonly string[] {
  return entitiesImplementing((definition) => definition.rootEntity === "space_object");
}

/**
 * Stored runtime-context source-reference type tokens.
 *
 * Inline text is unsupported: every stored context item must resolve to an
 * authorized product object.
 */
export function contextIncludableItemTypes(): readonly string[] {
  return registeredEntities()
    .map((definition) => definition.contextIncludable?.itemType)
    .filter((value): value is string => typeof value === "string");
}

/** Stored `cards.source_type` tokens. */
export function cardSourceTypes(): readonly string[] {
  return registeredEntities()
    .map((definition) => definition.cardSourceable?.sourceType)
    .filter((value): value is string => typeof value === "string");
}

/**
 * `provenance_links.source_type` sentinels: values that reference no row and
 * therefore cannot be an entity declaration.
 *
 * Exactly one, named here rather than left implicit so the list stays auditable.
 */
export const PROVENANCE_SOURCE_SENTINELS: readonly string[] = ["external_source"];

/** Stored `provenance_links.source_type` tokens: declarations plus sentinels. */
export function provenanceSourceTypes(): readonly string[] {
  return [
    ...registeredEntities()
      .map((definition) => definition.provenanceSourceable?.sourceType)
      .filter((value): value is string => typeof value === "string"),
    ...PROVENANCE_SOURCE_SENTINELS,
  ];
}

let provenanceSourceTypeSet: Set<string> | null = null;

/**
 * Registry-backed check for `provenance_links.source_type`.
 *
 * The database keeps only a format constraint (B12F), so this is what makes a
 * bad value an error rather than a row. Callers should not re-implement it:
 * three separate copies of this list existed, two of which *silently dropped*
 * unrecognized entries, so a divergence lost provenance without an error.
 */
export function isProvenanceSourceType(value: unknown): value is string {
  provenanceSourceTypeSet ??= new Set(provenanceSourceTypes());
  return typeof value === "string" && provenanceSourceTypeSet.has(value);
}

const notDeleted = (alias: string): string => `${alias}.deleted_at IS NULL`;

/** Stored runtime-context source-reference token per entity. */
const CONTEXT_ITEM_TYPES: Record<string, string | undefined> = {
  memory_entry: "memory",
  knowledge_item: "knowledge_item",
  // `note` is a first-class runtime-context source-reference type.
  // while the chat candidate collector produced note items, so persisting such
  // a snapshot would have failed the constraint. Registry validation surfaced
  // it; the entity list is the correct one.
  note: "note",
  source: "source",
  extracted_evidence: "extracted_evidence",
  activity: "activity_record",
  project_public_summary: "project_public_summary",
  task: "task",
  project: "project",
  project_folder: "project_folder",
  run: "run",
  proposal: "proposal",
  artifact: "artifact",
};

/** Stored `cards.source_type` token per entity. */
const CARD_SOURCE_TYPES: Record<string, string | undefined> = {
  note: "note",
  knowledge_item: "knowledge_item",
  source: "source",
  activity: "activity",
  run: "run",
  proposal: "proposal",
};

/**
 * Stored `provenance_links.source_type` token per entity.
 *
 * This list was audited on 2026-08-06 by asking, for each member, what writes
 * it and what `source_id` actually holds. The answers did not match the names:
 *
 * - `run_step` was written only from `payload.source_run_id` and read back as
 *   a run id. It is the `run` entity, so it is called that now.
 * - `user_confirmation` stores a user id, so the entity behind it is `user`.
 *   The token keeps its name — it is a stored identifier with rows behind it,
 *   the same reason `memory_entry` is stored as `memory` — but it is declared
 *   rather than free-floating, so the registry can say what `source_id`
 *   resolves to.
 * - `run_event` had neither a writer nor a reader, and would have been an
 *   aggregate's internal structure rather than an entity (B12C). Dropped, as
 *   `idea` was from the context item types.
 *
 * Two members stay despite having no writer, for different reasons.
 * `source_snapshot` has a live *reader*: `retrieval/sourcePolicy.ts` joins
 * `source_snapshots` on it to recover a connection id. `external_source` is a
 * genuine sentinel — material from outside the system with no row to point at
 * and the memory trust gate has a covered path for an untrusted external
 * reference. It is not a context item.
 */
const PROVENANCE_SOURCE_TYPES: Record<string, string | undefined> = {
  activity: "activity",
  proposal: "proposal",
  memory_entry: "memory",
  artifact: "artifact",
  run: "run",
  user: "user_confirmation",
  source_item: "source_item",
  source_snapshot: "source_snapshot",
  extracted_evidence: "extracted_evidence",
  note: "note",
};

function registerCoreEntities(): void {
  // The ontology root. Every `space_objects` subtype inherits its access
  // declaration from here — see the granularity note at the top.
  registerEntity({
    entityType: "space_object",
    owner: "ontology",
    graphable: true,
    contentAccessible: {
      tableName: "space_objects",
      ownerColumn: "owner_user_id",
      projectColumn: "primary_project_id",
      projectFolderColumn: "project_folder_id",
      projectShare: {
        tableName: "space_object_project_shares",
        resourceColumn: "object_id",
        projectColumn: "project_id",
        revokedColumn: "revoked_at",
      },
      activePredicate: notDeleted,
      publishable: true,
    },
  });

  const objectSubtypes: readonly [string, string, { evidenceable?: boolean; governed?: boolean }][] = [
    ["knowledge_item", "knowledge", { evidenceable: true, governed: true }],
    ["note", "knowledge", { evidenceable: true }],
    ["source", "knowledge", { evidenceable: true }],
    ["claim", "knowledge", { evidenceable: true, governed: true }],
    ["person", "relations", {}],
    ["organization", "relations", {}],
  ];
  const STATUS_TABLES: Record<string, { table: string; column: string }> = {
    knowledge_item: { table: "knowledge_items", column: "status" },
    note: { table: "notes", column: "status" },
    source: { table: "sources", column: "status" },
    claim: { table: "claims", column: "status" },
    person: { table: "relation_people", column: "status" },
    organization: { table: "relation_organizations", column: "status" },
  };
  for (const [entityType, owner, extra] of objectSubtypes) {
    registerEntity({
      entityType,
      rootEntity: "space_object",
      owner,
      ...(STATUS_TABLES[entityType] ? { domainStatus: STATUS_TABLES[entityType]! } : {}),
      retrievable: entityType !== "person" && entityType !== "organization",
      graphable: true,
      ...(CONTEXT_ITEM_TYPES[entityType] ? { contextIncludable: { itemType: CONTEXT_ITEM_TYPES[entityType]! } } : {}),
      ...(CARD_SOURCE_TYPES[entityType] ? { cardSourceable: { sourceType: CARD_SOURCE_TYPES[entityType]! } } : {}),
      ...(PROVENANCE_SOURCE_TYPES[entityType] ? { provenanceSourceable: { sourceType: PROVENANCE_SOURCE_TYPES[entityType]! } } : {}),
      ...extra,
    });
  }

  // Entities that are not `space_objects` rows. Their presence here is the
  // point: unification is about one registry, not one table.
  const independentRoots: readonly (Omit<EntityDefinition, "owner"> & { owner: string })[] = [
    {
      entityType: "memory_entry",
      owner: "memory",
      retrievable: true,
      governed: true,
      contentAccessible: {
        resourceType: "memory",
        tableName: "memory_entries",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: notDeleted,
        publishable: true,
      },
    },
    {
      entityType: "task",
      owner: "tasks",
      contentAccessible: {
        tableName: "tasks",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        activePredicate: notDeleted,
        publishable: true,
      },
    },
    {
      entityType: "artifact",
      owner: "artifacts",
      contentAccessible: {
        tableName: "artifacts",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        contextTaintColumn: "metadata_json",
        publishable: true,
      },
    },
    {
      entityType: "run",
      owner: "runs",
      contentAccessible: {
        tableName: "runs",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        publishable: false,
      },
    },
    {
      entityType: "proposal",
      owner: "proposals",
      contentAccessible: {
        tableName: "proposals",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        publishable: false,
      },
    },
    {
      entityType: "activity",
      owner: "activity",
      contentAccessible: {
        tableName: "activity_records",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        publishable: false,
      },
    },
    {
      // A user is a provenance source: `provenance_links` records "a human
      // confirmed this" with the user's id. It carries no other interface —
      // users are not gated content, not retrievable, not graph nodes — and an
      // entity with one declaration is the registry working as intended
      // rather than a gap.
      entityType: "user",
      owner: "auth",
    },
    {
      entityType: "agent",
      owner: "agents",
      contentAccessible: {
        tableName: "agents",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: (alias) => `${alias}.status <> 'archived'`,
        publishable: false,
      },
    },
    {
      entityType: "source_connection",
      owner: "sources",
      contentAccessible: {
        tableName: "source_connections",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: notDeleted,
        publishable: false,
      },
    },
    {
      entityType: "source_item",
      owner: "sources",
      retrievable: true,
      evidenceable: true,
      contentAccessible: {
        tableName: "source_items",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: notDeleted,
        publishable: false,
      },
    },
    {
      entityType: "source_snapshot",
      owner: "sources",
      contentAccessible: {
        tableName: "source_snapshots",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        publishable: false,
      },
    },
    {
      entityType: "extracted_evidence",
      owner: "sources",
      retrievable: true,
      evidenceable: true,
      contentAccessible: {
        tableName: "extracted_evidence",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: notDeleted,
        publishable: false,
      },
    },
    {
      // A session a person had with their own CLI, imported from a host they
      // own. An independent root, not a `space_objects` subtype: it takes part
      // in no cross-domain semantic relation and is only ever cited as
      // provenance for what was extracted from it.
      entityType: "imported_session",
      owner: "importedSessions",
      contentAccessible: {
        tableName: "imported_sessions",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        publishable: false,
      },
      // A memory extracted from imported history says where it came from, and
      // without this declaration that provenance is silently dropped and the
      // memory is then rejected for having none.
      provenanceSourceable: { sourceType: "imported_session" },
    },
    {
      entityType: "token_usage_event",
      owner: "usage",
      contentAccessible: {
        tableName: "token_usage_events",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        projectFolderColumn: "project_folder_id",
        publishable: false,
      },
    },
    {
      entityType: "reader_annotation",
      owner: "reader",
      contentAccessible: {
        tableName: "reader_annotations",
        ownerColumn: "owner_user_id",
        projectColumn: "project_id",
        activePredicate: (alias) => `${alias}.status = 'active'`,
        publishable: false,
      },
    },
    // Retrieval-only entities: projected and searchable, with no content-access
    // row of their own because the gate runs on their owning Project.
    { entityType: "project_public_summary", owner: "projects", retrievable: true },
    // Project-owned ontology object (ADR 0011 decision 1). `requiresProjectScope`
    // is what makes the Project gate enforced rather than remembered.
    {
      entityType: "inquiry_thread",
      owner: "inquiry",
      rootEntity: "space_object",
      retrievable: true,
      graphable: true,
      requiresProjectScope: true,
      domainStatus: { table: "inquiry_threads", column: "lifecycle_status" },
    },
    // Project-owned aggregate roots recovered alongside Inquiry (ADR 0011
    // decision 1). Not retrievable: neither has a retrieval adapter, and
    // declaring the interface without one would be a lie the test would catch.
    {
      entityType: "decision_case",
      owner: "decisions",
      rootEntity: "space_object",
      graphable: true,
      requiresProjectScope: true,
      domainStatus: { table: "decision_cases", column: "status" },
    },
    {
      entityType: "experiment",
      owner: "experiments",
      rootEntity: "space_object",
      graphable: true,
      requiresProjectScope: true,
      domainStatus: { table: "experiment_definitions", column: "status" },
    },
    {
      entityType: "research_workflow",
      owner: "projectResearch",
      rootEntity: "space_object",
      graphable: true,
      requiresProjectScope: true,
      domainStatus: { table: "project_research_workflows", column: "status" },
    },
  ];
  // Retrieval-only / structural entities with no content-access row of their
  // own: the gate runs on their owning Project.
  const structural: readonly EntityDefinition[] = [
    { entityType: "project", owner: "projects" },
    { entityType: "project_folder", owner: "projectFolders" },
  ];

  for (const definition of [...independentRoots, ...structural]) {
    const itemType = CONTEXT_ITEM_TYPES[definition.entityType];
    const sourceType = CARD_SOURCE_TYPES[definition.entityType];
    const provenanceType = PROVENANCE_SOURCE_TYPES[definition.entityType];
    registerEntity({
      ...definition,
      ...(itemType ? { contextIncludable: { itemType } } : {}),
      ...(sourceType ? { cardSourceable: { sourceType } } : {}),
      ...(provenanceType ? { provenanceSourceable: { sourceType: provenanceType } } : {}),
    });
  }
}

registerCoreEntities();
