import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Every test here drops and reapplies the whole baseline, so each one costs
// 5-10s alone and considerably more under parallel load. The global 30s ceiling
// was failing them on contention rather than on anything being wrong.
vi.setConfig({ testTimeout: 180_000 });
import { Pool } from "pg";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadMigrations, migrate } from "../src/db/migrator.js";

// Empty-DB migration test. Applies the single runtime baseline to a fresh
// Postgres via the server migration runner and asserts the resulting schema
// applies cleanly and idempotently.
//
// Verifies the runner creates representative server-owned tables from the
// baseline. Skips gracefully without Docker.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const RUNNER_TABLE = "server_schema_migrations";

// A representative spread across domains; a missing one means an incomplete apply.
const REPRESENTATIVE_TABLES = [
  "spaces",
  "space_objects",
  "users",
  "memory_entries",
  "runs",
  "proposals",
  "settings",
  "scheduler_tasks",
  "knowledge_items",
  "claims",
  "claim_sources",
  "object_relations",
  "space_object_profiles",
  "space_object_profile_relation_hints",
  "retrieval_objects",
  "retrieval_aliases",
  "retrieval_chunks",
  "retrieval_edges",
  "retrieval_feedback_events",
  "model_providers",
  "source_recipe_versions",
  "policy_decision_records",
  "agent_run_groups",
  "agent_run_group_members",
  "agent_run_messages",
  "run_delegations",
  "evolution_strategy_assets",
  "evolution_experiences",
  "evolution_selector_decisions",
];


const db = useTestDatabase(import.meta.filename, { empty: true });

beforeAll(async () => {
  if (!db.available) return;
  // The tests below apply the baseline themselves; start from nothing.
});

/**
 * Only the tests that assert a from-scratch apply need an empty schema;
 * dropping and re-creating ~300 tables is slow enough under parallel load
 * that doing it before every test used to dominate this file's run time. The
 * other tests rely on `migrate` being idempotent and clear their rows with
 * `resetTables` instead.
 */
async function resetSchema(p: Pool): Promise<void> {
  await p.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public; RESET search_path;");
}

async function baselineTableNames(p: Pool): Promise<string[]> {
  const res = await p.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name <> $1
       ORDER BY table_name`,
    [RUNNER_TABLE],
  );
  return res.rows.map((r) => r.table_name);
}

function normalizeBaselineSql(sql: string): string {
  return sql
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\bvarchar\(/g, "character varying(")
    .replace(/\bCREATE TABLE (?!public\.)([a-z_][a-z0-9_]*)/g, "CREATE TABLE public.$1")
    .replace(/,\s*/g, ", ")
    .replace(/[ \t]+/g, " ");
}

function baselineSql(): string {
  return normalizeBaselineSql(readFileSync(join(MIGRATIONS_DIR, "0001_baseline.sql"), "utf8"));
}

function tableDefinition(sql: string, table: string): string {
  const match = new RegExp(`CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(normalizeBaselineSql(sql));
  return match?.[1] ?? "";
}

describe("server runner applies the baseline schema", () => {
  // Asserted literally so that adding a migration is a deliberate edit here,
  // not a silent side effect of a schema change elsewhere. There is one file:
  // no deployment carries data that predates it, so upgrades are folded into
  // the baseline rather than chained behind it.
  it("keeps the schema in a single baseline file", () => {
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    expect(migrationFiles).toEqual(["0001_baseline.sql"]);
  });

  it("carries the execution topology the Folder/Location split needs", () => {
    // What the retired upgrade file used to establish, now asserted against
    // the baseline itself: a Location is the physical checkout, and a Folder
    // no longer names a host or a path.
    const baseline = baselineSql();
    expect(baseline).toContain("CREATE TABLE public.workspace_locations");
    expect(baseline).toContain("CREATE TABLE public.machines");
    expect(baseline).toContain("execution_host_kind character varying(16) NOT NULL");
    expect(tableDefinition(baseline, "project_folders")).not.toMatch(/\bhost_id\b|\bhost_kind\b|\broot_path\b/);
  });

  // B12D/B12E: domain lifecycle state belongs to the owning extension table,
  // and the root must not carry a constraint that branches on `object_type` —
  // that shape forced every new domain to edit a root-table constraint.
  it("keeps the object root ignorant of domain status", () => {
    const baseline = baselineSql();
    expect(baseline).not.toContain("ck_space_objects_status_by_type");
    expect(baseline).not.toContain("ck_space_objects_status");
    expect(tableDefinition(baseline, "space_objects")).not.toContain("status character varying");
  });

  it("constrains status on each extension table that owns one", () => {
    const baseline = baselineSql();
    for (const [table, constraint, sample] of [
      ["knowledge_items", "ck_knowledge_items_status", "'superseded'"],
      ["notes", "ck_notes_status", "'archived'"],
      ["sources", "ck_sources_status", "'processing'"],
      ["claims", "ck_claims_status", "'disputed'"],
      ["relation_people", "ck_relation_people_status", "'archived'"],
      ["relation_organizations", "ck_relation_organizations_status", "'archived'"],
    ] as const) {
      expect(tableDefinition(baseline, table)).toContain("status character varying");
      expect(baseline).toContain(constraint);
      expect(baseline.slice(baseline.indexOf(constraint))).toContain(sample);
    }
  });

  it("keeps Activity Inbox pointer aggregation schema in the baseline", () => {
    const baseline = baselineSql();
    const activityRecords = tableDefinition(baseline, "activity_records");
    expect(activityRecords).toContain("aggregate_key character varying(128)");
    expect(baseline).toContain("CREATE UNIQUE INDEX uq_activity_records_space_aggregate_key");
    expect(baseline).toContain("WHERE (aggregate_key IS NOT NULL)");
  });

  it("keeps ClaimFact and object relation tables FK-backed and retrievable", () => {
    const baseline = baselineSql();
    expect(baseline).toContain("CREATE TABLE public.claims");
    expect(baseline).toContain("CREATE TABLE public.claim_sources");
    expect(baseline).toContain("CREATE TABLE public.object_relations");
    expect(baseline).toContain("ck_claim_sources_source_ref_connection");
    expect(baseline).toContain("FOREIGN KEY (object_id, space_id) REFERENCES public.space_objects(id, space_id)");
    expect(baseline).toContain("FOREIGN KEY (claim_id, space_id) REFERENCES public.claims(object_id, space_id)");
    expect(baseline).toContain("FOREIGN KEY (from_object_id, space_id) REFERENCES public.space_objects(id, space_id)");
    expect(baseline).toContain("'claim', 'memory_entry'");
  });

  it("keeps object_relations as the canonical relation graph", () => {
    const baseline = baselineSql();
    const objectRelations = tableDefinition(baseline, "object_relations");
    expect(objectRelations).toContain("from_object_id character varying(36) NOT NULL");
    expect(objectRelations).toContain("to_object_id character varying(36) NOT NULL");
    expect(objectRelations).toContain("source_proposal_id character varying(36)");
    expect(baseline).toContain("object_relations_source_proposal_id_fkey");
    expect(baseline).toContain("FOREIGN KEY (from_object_id, space_id) REFERENCES public.space_objects(id, space_id)");
    expect(baseline).toContain("FOREIGN KEY (to_object_id, space_id) REFERENCES public.space_objects(id, space_id)");
  });

  it("keeps KnowledgeItem and MemoryEntry on canonical source and proposal fields", () => {
    const baseline = baselineSql();
    const knowledgeItemSources = tableDefinition(baseline, "knowledge_item_sources");
    const knowledgeItems = tableDefinition(baseline, "knowledge_items");
    expect(knowledgeItemSources).toContain("knowledge_item_id character varying(36) NOT NULL");
    expect(knowledgeItemSources).toContain("source_id character varying(36) NOT NULL");
    // Citation lineage keeps `relation_type` on purpose (B12A): it is not an
    // ontology edge, and merging its vocabulary with link types is exactly
    // what the boundaries file forbids.
    expect(knowledgeItemSources).toContain("relation_type character varying(32) NOT NULL");
    expect(knowledgeItems).toContain("created_from_proposal_id character varying(36)");
    expect(baseline).toContain("knowledge_item_sources_source_id_fkey");
    expect(baseline).toContain("knowledge_item_sources_knowledge_item_id_fkey");
    expect(baseline).toContain("knowledge_items_created_from_proposal_id_fkey");

    const memoryEntries = tableDefinition(baseline, "memory_entries");
    expect(memoryEntries).toContain("memory_type character varying(32) NOT NULL");
    expect(memoryEntries).toContain("memory_layer character varying(32)");
    expect(memoryEntries).toContain("created_from_proposal_id character varying(36)");
    expect(baseline).toContain("ck_memory_entries_memory_layer");
    expect(baseline).toContain("ck_memory_entries_scope_type");
    expect(baseline).toContain("scope_type IN ('user', 'project')");
    expect(baseline).toContain("ix_memory_entries_memory_type");
    expect(baseline).toContain("memory_entries_created_from_proposal_id_fkey");
  });

  it("keeps retrieval base object types centralized in a generated database enum", () => {
    const baseline = baselineSql();
    expect(baseline).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(baseline).toContain("CREATE TYPE public.retrieval_object_type AS ENUM");
    expect(baseline).toContain("CREATE TABLE public.space_object_profiles");
    expect(baseline).toContain("CREATE TABLE public.space_object_profile_relation_hints");
    expect(baseline).toContain("base_object_type retrieval_object_type NOT NULL");
    expect(baseline).toContain("endpoint_object_type retrieval_object_type NOT NULL");
    expect(baseline).toContain("object_type retrieval_object_type NOT NULL");
    expect(baseline).toContain("from_object_type retrieval_object_type NOT NULL");
    expect(baseline).toContain("to_object_type retrieval_object_type NOT NULL");
    expect(baseline).not.toContain("ck_space_object_profiles_base_object_type");
    expect(baseline).not.toContain("ck_space_object_profile_relation_hints_endpoint_type");
    expect(baseline).not.toContain("ck_note_links_endpoint_type");
    expect(baseline).not.toContain("ck_retrieval_objects_object_type");
    expect(baseline).not.toContain("ck_retrieval_aliases_object_type");
    expect(baseline).not.toContain("ck_retrieval_chunks_object_type");
    expect(baseline).not.toContain("ck_retrieval_edges_from_object_type");
    expect(baseline).not.toContain("ck_retrieval_edges_to_object_type");
    expect(baseline).not.toContain("ck_retrieval_feedback_events_object_type");
    expect(baseline).toContain("ck_space_object_profile_relation_hints_link_type_format");
    expect(baseline).toContain(
      "'knowledge_item', 'note', 'source', 'claim', 'memory_entry', 'project_public_summary', 'source_item', 'extracted_evidence'",
    );
  });

  it("keeps note collection trees and memberships space-scoped in the baseline", () => {
    const baseline = baselineSql();
    expect(baseline).toContain("CREATE TABLE public.note_collection_items");
    expect(baseline).toContain("space_id character varying(36) NOT NULL");
    expect(baseline).toContain("collection_id character varying(36) NOT NULL");
    expect(baseline).toContain("FOREIGN KEY (collection_id, space_id) REFERENCES public.note_collections(id, space_id)");
    expect(baseline).toContain("FOREIGN KEY (note_id, space_id) REFERENCES public.notes(object_id, space_id)");
    expect(baseline).toContain("FOREIGN KEY (parent_id, space_id) REFERENCES public.note_collections(id, space_id)");
  });

  it("keeps evolution core schema and built-in strategies in the baseline", () => {
    const baseline = baselineSql();
    expect(baseline).toContain("CREATE TABLE public.evolution_strategy_assets");
    expect(baseline).toContain("CREATE TABLE public.evolution_experiences");
    expect(baseline).toContain("CREATE TABLE public.evolution_selector_decisions");
    expect(baseline).toContain("ck_evolution_strategy_assets_target_type");
    expect(baseline).toContain("ck_evolution_strategy_assets_risk_level");
    expect(baseline).toContain("ck_evolution_experiences_outcome_status");
    expect(baseline).toContain("uq_evolution_strategy_assets_system_key");
    expect(baseline).toContain("uq_evolution_strategy_assets_space_key");
    expect(baseline).toContain("ix_evolution_selector_decisions_space_target_created");
    expect(baseline).toContain("evolution_selector_decisions_selected_strategy_asset_id_fkey");

    // Built-in strategy keys are seed data, not schema — they're upserted at
    // runtime by runBuiltInSeeds (server/src/db/seeds.ts), not embedded in
    // the migration. Check the seed source instead of the baseline SQL.
    const seedsSource = readFileSync(join(process.cwd(), "src/db/seeds.ts"), "utf8");
    for (const key of [
      "repair.runtime_failure",
      "repair.validation_failure",
      "optimize.prompt_asset",
      "optimize.tool_usage",
      "harden.policy_boundary",
      "improve.capability_gap",
      "review.open_skill_import",
      "maintain.memory_health",
      "maintain.knowledge_retrieval",
      "solidifyExperience.successful_run",
    ]) {
      expect(seedsSource).toContain(key);
    }
  });

  it("keeps Source Recipe schema in the consolidated baseline", () => {
    const baseline = baselineSql();
    const sourceConnections = tableDefinition(baseline, "source_connections");
    const sourceHandlerVersions = tableDefinition(baseline, "source_handler_versions");
    expect(baseline).toContain("CREATE TABLE public.source_recipe_versions");
    expect(sourceConnections).toContain("active_recipe_version_id character varying(36)");
    expect(sourceConnections).toContain("'recipe'::character varying");
    expect(sourceHandlerVersions).toContain("'declarative_pipeline_v1'::character varying");
    expect(baseline).toContain("source_connections_active_recipe_version_id_fkey");
    expect(baseline).toContain("'source_recipe'::character varying");
  });

  it("keeps Agent Room delegation schema in the consolidated baseline", () => {
    const baseline = baselineSql();
    const runs = tableDefinition(baseline, "runs");
    const groups = tableDefinition(baseline, "agent_run_groups");
    const members = tableDefinition(baseline, "agent_run_group_members");
    const messages = tableDefinition(baseline, "agent_run_messages");
    const delegations = tableDefinition(baseline, "run_delegations");

    expect(baseline).toContain("CREATE TABLE public.agent_run_groups");
    expect(baseline).toContain("CREATE TABLE public.agent_run_group_members");
    expect(baseline).toContain("CREATE TABLE public.agent_run_messages");
    expect(baseline).toContain("CREATE TABLE public.run_delegations");
    expect(runs).toContain("root_run_id character varying(36)");
    expect(runs).toContain("run_group_id character varying(36)");
    expect(runs).toContain("delegation_id character varying(36)");
    expect(runs).toContain("instructed_by_agent_id character varying(36)");
    expect(runs).toContain("'delegation'::character varying");
    expect(groups).toContain("manager_user_id character varying(36) NOT NULL");
    expect(members).toContain("CONSTRAINT ck_agent_run_group_members_role");
    expect(messages).toContain("sender_actor_ref_json jsonb NOT NULL");
    expect(delegations).toContain("policy_decision_record_id character varying(36)");
    expect(delegations).toContain("CONSTRAINT ck_run_delegations_status");
    expect(baseline).toContain("uq_agent_run_group_members_group_agent");
    expect(baseline).toContain("uq_agents_space_id_id");
    expect(baseline).toContain("uq_runs_space_id_id");
    expect(baseline).toContain("uq_agent_run_groups_space_id_id");
    expect(baseline).toContain("uq_run_delegations_space_id_id");
    expect(baseline).toContain("ix_run_delegations_status_updated");
    expect(baseline).toContain("runs_delegation_id_fkey");
    expect(baseline).toContain("fk_runs_delegation_same_space");
    expect(baseline).toContain("fk_run_delegations_group_same_space");
    expect(baseline).toContain("fk_agent_run_group_members_agent_same_space");
    expect(baseline).toContain("run_delegations_policy_decision_record_id_fkey");
    expect(baseline).toContain("'delegation_policy_denied'::character varying");
  });

  it("applies the baseline and creates representative server-owned tables", async () => {
    if (!db.available) return;
    await resetSchema(db.pool);

    const expectedVersions = loadMigrations(MIGRATIONS_DIR).map((f) => f.version);
    const result = await migrate(db.pool, MIGRATIONS_DIR);
    expect(result.all).toEqual(expectedVersions);
    expect(result.applied).toContain("0001");

    const recorded = await db.pool.query(
      `SELECT version FROM public.${RUNNER_TABLE} WHERE version = '0001'`,
    );
    expect(recorded.rowCount).toBe(1);

    const tables = await baselineTableNames(db.pool);
    for (const t of REPRESENTATIVE_TABLES) {
      expect(tables).toContain(t);
    }
  }, 120_000);

  it("creates the Machine/Host/Location topology from the baseline alone", async () => {
    if (!db.available) return;
    await migrate(db.pool, MIGRATIONS_DIR);
    const topology = await db.pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])`,
      [["machines", "workspace_locations"]],
    );
    expect(topology.rows.map((row) => row.table_name).sort()).toEqual(["machines", "workspace_locations"]);
    const columns = await db.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'project_folders' AND column_name = ANY($1::text[]))
            OR (table_name = 'host_task_threads' AND column_name = 'workspace_location_id')
            OR (table_name = 'runs' AND column_name = ANY($2::text[])))`,
      [["host_id", "host_kind", "root_path", "display_path"], ["workspace_location_id", "trust_mode"]],
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      { table_name: "host_task_threads", column_name: "workspace_location_id" },
      { table_name: "runs", column_name: "workspace_location_id" },
      { table_name: "runs", column_name: "trust_mode" },
    ]));
    expect(columns.rows.some((row) => row.table_name === "project_folders" && ["host_id", "host_kind", "root_path", "display_path"].includes(row.column_name))).toBe(false);
    const applied = await db.pool.query<{ version: string }>(
      `SELECT version FROM public.${RUNNER_TABLE} ORDER BY version`,
    );
    expect(applied.rows.map((row) => row.version)).toEqual(["0001"]);
  }, 120_000);

  it("rejects unknown user states, and constrains object_type by format only", async () => {
    if (!db.available) return;
    await migrate(db.pool, MIGRATIONS_DIR);
    await resetTables(db.pool, ["users", "spaces"], { cascade: true });

    await expect(db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('invalid-user', 'Invalid', 'pending', now(), now())`,
    )).rejects.toMatchObject({ code: "23514" });

    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('user-1', 'User', 'active', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('space-1', 'Space', 'team', 'user-1', now(), now())`,
    );

    await expect(db.pool.query(
      `INSERT INTO memory_entries (
         id, space_id, scope_type, memory_type, content, status, visibility,
         access_level, sensitivity_level, confidence, importance, version,
         access_count, created_at, updated_at
       ) VALUES ('memory-invalid-scope', 'space-1', 'agent', 'semantic', 'x',
                 'active', 'space_shared', 'full', 'normal', 1, 0.5, 1, 0, now(), now())`,
    )).rejects.toMatchObject({ code: "23514" });

    // `object_type` used to carry a closed-set CHECK. ADR 0012 moved definition
    // authority into the registerable entity registry and demoted the column to
    // a format constraint (B12F), because a database CHECK cannot express that
    // a type needs a registered implementation — and every new domain would
    // otherwise need a migration to declare itself.
    await expect(db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, access_level, owner_user_id, created_at, updated_at) VALUES (
         'object-bad', 'space-1', 'Not A Type', 'Bad format',
         'private', 'full', 'user-1', now(), now()
       )`,
    )).rejects.toMatchObject({ code: "23514" });

    // A registered domain root is accepted at the database level; whether a
    // given string names a registered entity is the registry's decision, and
    // `ontologyRegistryGuard` is where that is enforced.
    await db.pool.query(
      `INSERT INTO space_objects (id, space_id, object_type, title, visibility, access_level, owner_user_id, created_at, updated_at) VALUES (
         'object-1', 'space-1', 'project', 'A Project',
         'private', 'full', 'user-1', now(), now()
       )`,
    );
  }, 120_000);

  it("enforces object kind registry constraints in Postgres", async () => {
    if (!db.available) return;
    await migrate(db.pool, MIGRATIONS_DIR);
    await resetTables(db.pool, ["users", "spaces"], { cascade: true });
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('user-1', 'User', 'active', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES
         ('space-1', 'Space 1', 'team', 'user-1', now(), now()),
         ('space-2', 'Space 2', 'team', 'user-1', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO proposals (
         id, space_id, proposal_type, status, risk_level, urgency, title,
         payload_json, created_by_user_id, created_at, updated_at
       ) VALUES
         ('proposal-1', 'space-1', 'object_profile_create', 'accepted', 'high', 'normal', 'Create kind', '{}'::jsonb, 'user-1', now(), now()),
         ('proposal-2', 'space-2', 'object_profile_create', 'accepted', 'high', 'normal', 'Create kind', '{}'::jsonb, 'user-1', now(), now())`,
    );

    await db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status,
         created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
         created_at, updated_at
       ) VALUES (
         'kind-1', 'space-1', 'question', 'Question', 'knowledge_item', 'active',
         'user-1', 'proposal-1', 'proposal-1', now(), now()
       )`,
    );

    await expect(db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status, created_at, updated_at
       ) VALUES (
         'kind-dup', 'space-1', 'question', 'Duplicate', 'knowledge_item', 'active', now(), now()
       )`,
    )).rejects.toThrow();

    await db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status,
         created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
         created_at, updated_at
       ) VALUES (
         'kind-other-space', 'space-2', 'question', 'Question', 'knowledge_item', 'active',
         'user-1', 'proposal-2', 'proposal-2', now(), now()
       )`,
    );
    await db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status,
         created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
         created_at, updated_at
       ) VALUES (
         'kind-other-base', 'space-1', 'question', 'Question claim', 'claim', 'active',
         'user-1', 'proposal-1', 'proposal-1', now(), now()
       )`,
    );

    await expect(db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status, created_at, updated_at
       ) VALUES (
         'kind-invalid-base', 'space-1', 'person', 'Person', 'person', 'active', now(), now()
       )`,
    )).rejects.toThrow();

    await expect(db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status, created_from_proposal_id, created_at, updated_at
       ) VALUES (
         'kind-bad-fk', 'space-1', 'lesson', 'Bad FK', 'knowledge_item', 'active', 'missing-proposal', now(), now()
       )`,
    )).rejects.toThrow();

    await db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status, created_at, updated_at
       ) VALUES (
         'kind-archived', 'space-1', 'email', 'Email', 'source', 'archived', now(), now()
       )`,
    );
    await expect(db.pool.query(
      `INSERT INTO space_object_profiles (
         id, space_id, key, label, base_object_type, status, created_at, updated_at
       ) VALUES (
         'kind-archived-reuse', 'space-1', 'email', 'Email replacement', 'source', 'active', now(), now()
       )`,
    )).rejects.toThrow();
  }, 120_000);

  it("is idempotent on an already-migrated database", async () => {
    if (!db.available) return;
    await resetSchema(db.pool);
    const first = await migrate(db.pool, MIGRATIONS_DIR);
    expect(first.applied).toContain("0001");

    const result = await migrate(db.pool, MIGRATIONS_DIR);
    expect(result.applied).toEqual([]);
    const tables = await baselineTableNames(db.pool);
    for (const t of REPRESENTATIVE_TABLES) {
      expect(tables).toContain(t);
    }
  }, 120_000);
});
