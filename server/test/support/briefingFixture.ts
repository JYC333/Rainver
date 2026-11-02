import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { BriefingModelOutput } from "@rainver/protocol";
import { loadConfig } from "../../src/config.js";
import { resetTables } from "./resetTables.js";
import { seedMainlineRoomsForAllProjects, seedServerHost } from "./domainSeeds.js";
import { InformationBriefingService } from "../../src/modules/informationDigest/briefing/service.js";
import { projectBriefingScope } from "../../src/modules/informationDigest/briefing/projectScope.js";
import { registerBriefingSettlement } from "../../src/modules/informationDigest/briefing/settlement.js";
import { PgRunRepository } from "../../src/modules/runs/repository.js";
import { runFinalizationReconcilerRegistry } from "../../src/modules/runs/finalizationReconcilerRegistry.js";

/**
 * A Project briefing world on real PostgreSQL: a team Space, a writer (OWNER)
 * and a viewer (MEMBER) both subscribed to one consenting Source, a third
 * Space member (NEWCOMER) outside the Project, a published Project brief, and
 * the writer's own Agent on a usable runtime. Synthetic text only.
 */
export const SPACE = "b1111111-1111-4111-8111-111111111111";
export const OWNER = "b2222222-2222-4222-8222-222222222222";
export const MEMBER = "b3333333-3333-4333-8333-333333333333";
export const NEWCOMER = "b4444444-4444-4444-8444-444444444444";
export const CONNECTOR = "b5555555-5555-4555-8555-555555555555";
export const CONNECTION = "b6666666-6666-4666-8666-666666666666";
export const CHANNEL = "b7777777-7777-4777-8777-777777777777";
export const PROJECT = "b8888888-8888-4888-8888-888888888888";
export const AGENT = "b9999999-9999-4999-8999-999999999999";
export const AGENT_VERSION = "ba999999-9999-4999-8999-999999999999";
export const PROFILE = "bb999999-9999-4999-8999-999999999999";
export const HOST = "bc999999-9999-4999-8999-999999999999";
export const BRIEF = "bd999999-9999-4999-8999-999999999999";
const CONSENTING = { allow_external_model_egress: true, allow_local_provider_egress: true };

export const BRIEFING_TABLES = [
  "information_briefing_inputs", "information_briefings", "information_digest_items", "information_digests",
  "automation_runs", "automations", "work_context_setups", "execution_control_snapshots", "retrieval_objects", "retrieval_aliases",
  "retrieval_chunks", "retrieval_edges", "memory_entries", "jobs", "runs", "project_corpus_items", "project_members",
  "project_brief_versions", "projects", "tasks", "source_goal_items", "source_goal_bindings", "source_goals",
  "source_item_annotations", "source_channel_user_subscriptions", "source_channel_item_links", "source_channels",
  "source_items", "source_connections", "source_provider_connectors", "source_providers", "source_connectors",
  "agent_runtime_profiles", "agent_versions", "agents", "hosts", "space_memberships", "users", "spaces",
];

export const manual = { kind: "manual" as const, execution: {}, origin: "manual" as const, label: "the Project \"Robotics\"" };

export function briefingWorld(db: { pool: Pool; connectionUri: string }) {
  const config = () => loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  const adapter = () => projectBriefingScope(SPACE, PROJECT);
  const service = () => new InformationBriefingService(db.pool, config());
  const runs = () => new PgRunRepository(db.pool);

  async function seed() {
    await resetTables(db.pool, BRIEFING_TABLES, { cascade: true });
    const now = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Team','team',$2,$2)`, [SPACE, now]);
    for (const user of [OWNER, MEMBER, NEWCOMER]) {
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,$1,'active',$2,$2,lower(gen_random_uuid()::text || '@test.invalid'),'system')`, [user, now]);
      await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',$4,$4)`, [randomUUID(), SPACE, user, now]);
    }
    await db.pool.query(`INSERT INTO source_connectors (id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at) VALUES ($1,'rss','RSS','external_feed','pull','active','{}'::jsonb,$2,$2)`, [CONNECTOR, now]);
    await db.pool.query(`INSERT INTO source_providers (id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at) VALUES ($1,'rss','RSS','named','general','active','{}'::jsonb,$2,$2)`, [CONNECTOR, now]);
    await db.pool.query(`INSERT INTO source_provider_connectors (id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at) VALUES ($1,$2,$2,'active',0,'{}'::jsonb,$3,$3)`, [CONNECTOR, CONNECTOR, now]);
    await addSource(CONNECTION, CHANNEL, "Robotics feed", CONSENTING, now);
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at) VALUES ($1,$2,$3,'Robotics','active','{}',$4,$4)`, [PROJECT, SPACE, OWNER, now]);
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',$5,$5)`, [randomUUID(), SPACE, PROJECT, MEMBER, now]);
    await db.pool.query(
      `INSERT INTO project_brief_versions (id,space_id,project_id,version,goal,constraints,project_status,status,created_at)
       VALUES ($1,$2,$3,'1','Ship a warehouse picking robot by Q3','Budget under 50k; no cloud dependency','active','published',$4)`,
      [BRIEF, SPACE, PROJECT, now],
    );
    await db.pool.query(`UPDATE projects SET active_brief_version_id=$2 WHERE id=$1`, [PROJECT, BRIEF]);
    // The requester's own Agent on a usable runtime: no system Agent is borrowed.
    await db.pool.query(`INSERT INTO agents (id,space_id,owner_user_id,name,status,current_version_id,visibility,created_at,updated_at) VALUES ($1,$2,$3,'Analyst','active',NULL,'private',$4,$4)`, [AGENT, SPACE, OWNER, now]);
    await db.pool.query(
      `INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at)
       VALUES ($1,$2,$3,'v1','Analyst','{}','{}','[]','{"allowed_tools":[]}',$4)`,
      [AGENT_VERSION, AGENT, SPACE, now],
    );
    await db.pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
    await seedServerHost(db.pool, { id: HOST });
    await db.pool.query(
      `UPDATE hosts SET kind='remote',environment_kind='linux_native',owner_user_id=$2,capabilities_json=$3,last_heartbeat_at=now() WHERE id=$1`,
      [HOST, OWNER, { runtimes: ["claude_code"], versions: { claude_code: "fixture" }, installations: { claude_code: [{ id: "own", version: "fixture", logged_in: true, options: { session_available: true, config_options: [] }, health_check_protocol: "acp" }] } }],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (id,space_id,agent_id,execution_host_id,workspace_mode,runtime_installation,name,runtime_key,backend_mode,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'managed','own','Default','claude_code','runtime_native','{}'::jsonb,'{}'::jsonb,true,true,$5,$5)`,
      [PROFILE, SPACE, AGENT, HOST, now],
    );
    if (!runFinalizationReconcilerRegistry.registeredKeys().has("information_briefing")) registerBriefingSettlement();
  }

  /** A Source (connection + channel) both Project readers subscribe to, with the given model-egress consent. */
  async function addSource(connection: string, channel: string, name: string, consent: Record<string, boolean>, at = new Date(Date.now() - 3 * 86_400_000).toISOString()) {
    await db.pool.query(
      `INSERT INTO source_connections (id,space_id,provider_connector_id,owner_user_id,name,status,visibility,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'active','space_shared','reference_only','normal',$6::jsonb,'{}','{}',$7,$7)`,
      [connection, SPACE, CONNECTOR, OWNER, name, JSON.stringify(consent), at],
    );
    await db.pool.query(`INSERT INTO source_channels (id,space_id,source_connection_id,created_by_user_id,name,channel_type,status,fetch_frequency,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'feed','active','daily',$6,$6)`, [channel, SPACE, connection, OWNER, `${name} channel`, at]);
    for (const user of [OWNER, MEMBER]) await subscribe(user, at, channel);
  }

  async function subscribe(user: string, at: string, channel = CHANNEL) {
    await db.pool.query(
      `INSERT INTO source_channel_user_subscriptions (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5) ON CONFLICT (space_id,source_channel_id,user_id) DO NOTHING`,
      [randomUUID(), SPACE, channel, user, at],
    );
  }

  /** A Corpus item of the Project, annotated (analysed) unless `analysed` is false. */
  async function material(title: string, options: {
    publishedHoursAgo?: number; addedHoursAgo?: number; analysed?: boolean; uri?: string; unverified?: boolean;
    owner?: string; connection?: string; channel?: string; reason?: string | null;
  } = {}): Promise<string> {
    const id = randomUUID();
    const published = new Date(Date.now() - (options.publishedHoursAgo ?? 2) * 3_600_000).toISOString();
    const added = new Date(Date.now() - (options.addedHoursAgo ?? 1) * 3_600_000).toISOString();
    const uri = options.uri ?? `https://news.test/${id}`;
    const connection = options.connection ?? CONNECTION;
    const channel = options.channel ?? CHANNEL;
    await db.pool.query(
      `INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,source_uri,canonical_uri,reading_initial_hash,source_domain,occurred_at,first_seen_at,last_seen_at,content_state,retention_policy,excerpt,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared',$4,'feed_entry',$5,$6,$6,'h0','news.test',$7,$8,$8,'excerpt_saved','summary_only',$9,$10::jsonb,$8,$8)`,
      [id, SPACE, options.owner ?? OWNER, connection, title, uri, published, added, `${title} excerpt`, JSON.stringify(options.unverified ? { result_provenance: "agent_provided_unverified" } : {})],
    );
    await db.pool.query(`INSERT INTO source_channel_item_links (id,space_id,source_channel_id,source_item_id,status,matched_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5,$5)`, [randomUUID(), SPACE, channel, id, added]);
    if (options.analysed !== false) await annotate(id, `${title} summary`, added, channel);
    await db.pool.query(
      `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,source_connection_id,role,status,triage_status,triage_confirmed_by_user,read_status,reason,metadata_json,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'candidate','active','new',false,'unread',$7,'{}',$6,$6)`,
      [randomUUID(), SPACE, PROJECT, id, connection, added, options.reason ?? null],
    );
    return id;
  }

  async function annotate(id: string, summary: string, at = new Date().toISOString(), channel = CHANNEL) {
    await db.pool.query(
      `INSERT INTO source_item_annotations (id,space_id,source_item_id,source_channel_id,status,domain_key,depth,genre,summary,topic_candidates_json,stance_polarity,stance_confidence,attempt_count,annotated_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'succeeded','robotics','analysis','news',$5,'[]'::jsonb,'neutral',0,1,$6,$6,$6)`,
      [randomUUID(), SPACE, id, channel, summary, at],
    );
  }

  /** A shared, open Project Task every Project reader may read. */
  async function task(title: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO tasks (id,space_id,project_id,title,status,created_by_user_id,owner_user_id,visibility,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'ready',$5,$5,'space_shared',now() - interval '1 hour',now() - interval '1 hour')`,
      [id, SPACE, PROJECT, title, OWNER],
    );
    return id;
  }

  const rowOf = async (id: string) => (await db.pool.query(`SELECT * FROM information_briefings WHERE id=$1`, [id])).rows[0];
  const runOf = async (id: string) => (await runs().getRun(SPACE, (await rowOf(id)).run_id))!;
  const inputsOf = async (id: string) => (await db.pool.query(
    `SELECT * FROM information_briefing_inputs WHERE briefing_id=$1 AND ref_kind='source_item' ORDER BY ref_key NULLS LAST`, [id],
  )).rows;
  const count = async (table: string) => (await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

  /** A terminal Run with the given final text, as the runtime would leave it (fixture output, not a model call). */
  async function finishRun(runId: string, text: string, status = "succeeded") {
    await db.pool.query(
      `UPDATE runs SET status=$2, started_at=now(), ended_at=now(), output_json=$3::jsonb,
         runtime_profile_id=requested_runtime_profile_id, runtime_profile_selection_source='explicit', runtime_key='claude_code', runtime_profile_snapshot_json='{}'::jsonb
       WHERE id=$1`,
      [runId, status, JSON.stringify({ schema_version: "run_output.v1", status, summary: "fixture", result: { output_text: text }, outputs: [] })],
    );
    return (await runs().getRun(SPACE, runId))!;
  }

  /** Pretends `hours` passed since every briefing so far was cut off. */
  async function age(hours: number) {
    await db.pool.query(`UPDATE information_briefings SET cutoff_at = cutoff_at - make_interval(hours => $1), since_at = since_at - make_interval(hours => $1)`, [hours]);
  }

  return { config, adapter, service, runs, seed, addSource, subscribe, material, annotate, task, rowOf, runOf, inputsOf, count, finishRun, age };
}

/** What the Agent replies, as an ACP Run's final text (fixture output, not a model call). */
export function output(overrides: Partial<BriefingModelOutput> = {}, novelty: "baseline" | "new" | "update" | "ongoing" = "baseline"): string {
  return "Here is the briefing:\n```json\n" + JSON.stringify(outputValue(overrides, novelty)) + "\n```";
}

export function outputValue(overrides: Partial<BriefingModelOutput> = {}, novelty: "baseline" | "new" | "update" | "ongoing" = "baseline"): BriefingModelOutput {
  return {
    schema: "information_briefing.v1",
    overview: { text: "Two reports describe the same gripper launch.", refs: ["S1"] },
    highlights: [{
      title: "Gripper launch",
      what_changed: "A vendor launched a soft gripper.",
      novelty,
      importance: "high",
      why_it_matters: "Picking fragile items is the open risk.",
      impact: { assessment: "affects", text: "Bears on the Q3 picking goal.", context_refs: ["C1"] },
      suggested_action: "watch",
      statements: [{ kind: "fact", text: "The gripper shipped.", refs: ["S1"] }, { kind: "inference", text: "It could replace our prototype.", refs: ["S1", "C1"] }],
      contradictions: null,
      refs: ["S1"],
    }],
    open_questions: [],
    ...overrides,
  };
}
