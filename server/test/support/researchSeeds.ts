import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SpaceUserIdentity } from "../../src/modules/routeUtils/common.js";
import { InquiryThreadService } from "../../src/modules/inquiry/threadService.js";

/**
 * Rows the Project Research files seed the same way: an arXiv source chain,
 * a relevant corpus item, a research Operation, a pending screening gate,
 * and a question Thread with its scope tuple. Literals match what the files
 * used to inline; pass an option when a test needs a different one.
 */

/** connector → provider → mapping → connection → channel, all arXiv. */
export async function seedArxivSourceChain(
  pool: Pool,
  input: {
    connector: string;
    connection: string;
    /** One channel with fingerprint `fp-a`, or several with their own fingerprints. */
    channel: string | Array<{ id: string; fingerprint: string }>;
    space: string;
    owner: string;
    now: string;
  },
): Promise<void> {
  const { connector, connection, space, owner, now } = input;
  const channels = typeof input.channel === "string" ? [{ id: input.channel, fingerprint: "fp-a" }] : input.channel;
  await pool.query(
    `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv_api','arXiv','external_feed','pull','active','{}'::jsonb,$2,$2)`,
    [connector, now],
  );
  const providerId = randomUUID();
  const mappingId = randomUUID();
  await pool.query(
    `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
     VALUES ($1,'arxiv','arXiv','generic','academic','active','{}'::jsonb,$2,$2)`,
    [providerId, now],
  );
  await pool.query(
    `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
     VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
    [mappingId, providerId, connector, now],
  );
  await pool.query(
    `INSERT INTO source_connections (
       id, space_id, provider_connector_id, owner_user_id, name, status,
       capture_policy, trust_level, consent_json, policy_json, config_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'arXiv','active','reference_only','normal',$5::jsonb,$6::jsonb,'{}'::jsonb,$7,$7)`,
    [
      connection, space, mappingId, owner,
      JSON.stringify({ schema_version: 1, owner_user_id: owner, allowed_reader_user_ids: [], allowed_agent_ids: [], allow_space_admins: true, allow_local_provider_egress: true, allow_external_model_egress: true }),
      JSON.stringify({ schema_version: 1, source_egress_class: "external_provider_allowed" }),
      now,
    ],
  );
  for (const channel of channels) {
    await pool.query(
      `INSERT INTO source_channels (
         id, space_id, source_connection_id, created_by_user_id, name, channel_type, endpoint_url,
         query_json, provider_query_json, query_fingerprint, status, fetch_frequency, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'Monitor','search','https://export.arxiv.org/api/query','{}'::jsonb,'{}'::jsonb,$5,'active','daily',$6,$6)`,
      [channel.id, space, connection, owner, channel.fingerprint, now],
    );
  }
}

/** A source item already triaged as relevant and linked into the Project corpus. */
export async function seedRelevantCorpusItem(
  pool: Pool,
  input: { space: string; project: string; owner: string; now?: string },
): Promise<{ sourceItemId: string; corpusItemId: string }> {
  const now = input.now ?? new Date().toISOString();
  const sourceItemId = randomUUID();
  const corpusItemId = randomUUID();
  await pool.query(
    `INSERT INTO source_items (
       id,space_id,owner_user_id,visibility,item_type,title,excerpt,
       first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at
     ) VALUES ($1,$2,$3,'space_shared','external_url','Relevant paper','Relevant evidence.',
       $4,$4,'excerpt_saved','summary_only',$4,$4)`,
    [sourceItemId, input.space, input.owner, now],
  );
  await pool.query(
    `INSERT INTO project_corpus_items (
       id,space_id,project_id,source_item_id,role,status,triage_status,
       triage_confirmed_by_user,relevance,confidence,reason,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','relevant',false,'relevant',0.9,'In scope',$5,$5)`,
    [corpusItemId, input.space, input.project, sourceItemId, now],
  );
  await pool.query(
    `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, input.space, input.project, sourceItemId, now],
  );
  return { sourceItemId, corpusItemId };
}

/** An active research Operation with the given progress state. */
export async function seedResearchOperation(
  pool: Pool,
  input: { id: string; space: string; project: string; owner: string; progress: unknown; now: string; title?: string; status?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research',$4,$5,$6,$7::jsonb,$8,$8)`,
    [input.id, input.space, input.project, input.title ?? "Initial literature intake", input.status ?? "active", input.owner, JSON.stringify(input.progress), input.now],
  );
}

/** A screening-gate checkpoint still waiting for its decision. */
export async function seedPendingScreeningGate(
  pool: Pool,
  input: { id: string; space: string; project: string; workflow: string; machineResult: unknown; now: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO project_research_checkpoints (id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status, machine_result_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'screening','screening_gate','pending',$5::jsonb,$6,$6)`,
    [input.id, input.space, input.project, input.workflow, JSON.stringify(input.machineResult), input.now],
  );
}

export interface QuestionThreadScope {
  thread_id: string;
  version: number;
  kind: "question";
  statement: string;
}

/** Creates a question Thread through the service and returns its scope tuple. */
export async function createQuestionThreadScope(
  pool: Pool,
  identity: SpaceUserIdentity,
  project: string,
  statement: string,
): Promise<QuestionThreadScope> {
  const thread = await new InquiryThreadService(pool).createThread(identity, project, { kind: "question", statement });
  return {
    thread_id: String(thread.id),
    version: Number(thread.version),
    kind: "question",
    statement: String(thread.statement),
  };
}
