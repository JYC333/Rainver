import { createHash, randomUUID } from "node:crypto";
import type { ServerConfig } from "../../../config.js";
import { HttpError, objectValue, optionalString, requiredString, type Queryable, type SpaceUserIdentity, withQueryableTransaction } from "../../routeUtils/common.js";
import { normalizeSourceConnectionCreateGovernance } from "../sourceConsent.js";
import { SourceProviderCatalogService, type ResolvedSourceProviderConnector } from "../catalog/sourceProviderCatalogService.js";
import { upsertSourceChannelScanTask } from "../sourceConnectionScheduler.js";
import { computeNextRunAtFromScheduleRule, type SourceScheduleRule } from "../sourceScheduleInput.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { PgProposalApplyService } from "../../proposals/applyService.js";
import { CustomSourceCredentialService } from "../customSources/customSourceCredentialService.js";
import type { ResearchCompiledQuery, ResearchProviderKey } from "@rainver/protocol";
import { ResearchProviderCompiler } from "../../research/queryPlanning/providerCompiler.js";

interface SourceChannelProposalActor {
  agentId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  projectId?: string | null;
}

export interface SourceChannelRow {
  id: string;
  space_id: string;
  source_connection_id: string;
  source_name?: string;
  created_by_user_id: string;
  name: string;
  channel_type: string;
  endpoint_url: string | null;
  query_json: unknown;
  provider_query_json: unknown;
  query_fingerprint: string | null;
  status: string;
  fetch_frequency: string;
  schedule_rule_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  provider_key?: string;
  provider_display_name?: string;
  connector_key?: string;
  connector_mapping_id?: string;
  connection_status?: string;
  capture_policy?: string;
  scan_status?: string | null;
  scan_metadata_json?: unknown;
  scan_next_run_at?: unknown;
  scan_last_run_at?: unknown;
  search_spec_provider_query_json?: unknown;
  search_spec_query_fingerprint?: string | null;
  research_query_attempt_id?: string | null;
  subscription_status?: string;
  recommendation_message?: string | null;
  last_notified_at?: unknown;
  connection_visibility?: string;
}

export interface SelectedResearchAttemptChannelInput {
  attemptId: string;
  providerKey: ResearchProviderKey;
  compiledQuery: ResearchCompiledQuery;
  credentialId?: string;
  name?: string;
}

export class SourceChannelService {
  private readonly catalog: SourceProviderCatalogService;
  private readonly researchCompiler = new ResearchProviderCompiler();

  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {
    this.catalog = new SourceProviderCatalogService(db);
  }

  async list(identity: SpaceUserIdentity, filters: { status?: string | null; providerKey?: string | null }) {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const clauses = ["ch.space_id = $1", "ch.created_by_user_id = $2"];
    if (filters.status) { params.push(filters.status); clauses.push(`ch.status = $${params.length}`); }
    if (filters.providerKey) { params.push(filters.providerKey); clauses.push(`p.provider_key = $${params.length}`); }
    const result = await this.db.query<SourceChannelRow>(
      `${this.selectSql()} WHERE ${clauses.join(" AND ")} ORDER BY ch.updated_at DESC, ch.id DESC`,
      params,
    );
    return result.rows.map((row) => this.channelOut(row));
  }

  async listRecommendations(identity: SpaceUserIdentity) {
    const result = await this.db.query<SourceChannelRow>(
      `SELECT channel_row.*, sub.status AS subscription_status,
              sub.recommendation_message, sub.last_notified_at
         FROM (${this.selectSql()}) channel_row
         JOIN source_channel_user_subscriptions sub
           ON sub.space_id=channel_row.space_id AND sub.source_channel_id=channel_row.id
        WHERE sub.space_id=$1 AND sub.user_id=$2 AND sub.status='pending'
          AND channel_row.status='active'
          AND channel_row.connection_visibility='space_shared'
        ORDER BY sub.updated_at DESC, channel_row.id DESC`,
      [identity.spaceId, identity.userId],
    );
    return result.rows.map((row) => ({
      ...this.channelOut(row),
      subscription_status: row.subscription_status ?? "pending",
      recommendation_message: row.recommendation_message ?? null,
      last_notified_at: row.last_notified_at ?? null,
    }));
  }

  async decideRecommendation(
    identity: SpaceUserIdentity,
    channelId: string,
    decision: "subscribed" | "dismissed" | "muted",
  ) {
    const now = new Date().toISOString();
    const result = await this.db.query<{ status: string }>(
      `UPDATE source_channel_user_subscriptions sub
          SET status=$4, updated_at=$5
         FROM source_channels ch, source_connections sc
        WHERE sub.space_id=$1 AND sub.user_id=$2 AND sub.source_channel_id=$3
          AND sub.status='pending' AND ch.id=sub.source_channel_id AND ch.space_id=sub.space_id
          AND ch.status='active'
          AND sc.id=ch.source_connection_id AND sc.space_id=ch.space_id
          AND sc.visibility='space_shared' AND sc.deleted_at IS NULL
      RETURNING sub.status`,
      [identity.spaceId, identity.userId, channelId, decision, now],
    );
    if (!result.rows[0]) throw new HttpError(404, "Pending source recommendation not found");
    return { source_channel_id: channelId, status: result.rows[0].status, updated_at: now };
  }

  /**
   * Return canonical channel DTOs for a trusted project/workflow response.
   * Project bindings can reference channels created by another member, so this
   * intentionally scopes by space and exact ids rather than the user-owned
   * listing above.
   */
  async listForSpaceByIds(identity: SpaceUserIdentity, channelIds: string[]) {
    const ids = [...new Set(channelIds.filter((id) => id.trim().length > 0))];
    if (ids.length === 0) return [];
    const result = await this.db.query<SourceChannelRow>(
      `${this.selectSql()}
        WHERE ch.space_id=$1 AND ch.id=ANY($2::text[])
        ORDER BY array_position($2::text[], ch.id)`,
      [identity.spaceId, ids],
    );
    return result.rows.map((row) => this.channelOut(row));
  }

  async get(identity: SpaceUserIdentity, channelId: string) {
    const result = await this.db.query<SourceChannelRow>(
      `${this.selectSql()} WHERE ch.space_id = $1 AND ch.id = $2 AND ch.created_by_user_id = $3 LIMIT 1`,
      [identity.spaceId, channelId, identity.userId],
    );
    return result.rows[0] ? this.channelOut(result.rows[0]) : null;
  }

  async create(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    return withQueryableTransaction(this.db, (db) =>
      new SourceChannelService(db, this.config).createLocked(identity, body));
  }

  private async createLocked(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    const providerKey = requiredString(body.provider_key, "provider_key");
    const provider = await this.catalog.resolve(providerKey);
    const credentialId = optionalString(body.credential_id);
    if (credentialId) {
      await new CustomSourceCredentialService(this.db, this.config).requireOwnCredential(identity, credentialId);
    }
    const query = objectValue(body.query);
    const input = {
      ...query,
      endpoint_url: optionalString(body.endpoint_url) ?? optionalString(query.endpoint_url),
      query,
    };
    const researchProviderKey = researchProviderForConnector(provider.connector_key);
    const compiledResearch = researchProviderKey ? this.researchCompiler.compileNative(researchProviderKey, input) : null;
    const compiled = compiledResearch
      ? { query: compiledResearch.query, providerQuery: compiledResearch.query, endpointUrl: null }
      : normalizeNonSearchChannel(provider.connector_key, input);
    const fingerprint = compiledResearch?.fingerprint ?? genericChannelFingerprint(providerKey, provider.connector_key, compiled.endpointUrl);
    const sourceName = optionalString(body.source_name) ?? provider.provider_display_name;
    const name = optionalString(body.name) ?? this.defaultName(providerKey, compiled.providerQuery);
    const frequency = optionalString(body.fetch_frequency) ?? "daily";
    if (!["manual", "hourly", "daily", "weekly"].includes(frequency)) {
      throw new HttpError(422, "fetch_frequency must be manual, hourly, daily, or weekly");
    }
    const status = body.status === "paused" ? "paused" : "active";
    const schedule = resolveChannelSchedule(body, frequency, status);
    const projectId = optionalString(body.project_id);
    const existing = body._force_create === true
      ? { rows: [] as SourceChannelRow[] }
      : await this.db.query<SourceChannelRow>(
      `${this.selectSql()} WHERE ch.space_id = $1 AND ch.created_by_user_id = $2
         AND CASE WHEN ch.channel_type='search' THEN ss.query_fingerprint ELSE ch.query_fingerprint END = $3
         AND sc.project_id IS NOT DISTINCT FROM $4
         AND ch.status <> 'archived' LIMIT 1`,
      [identity.spaceId, identity.userId, fingerprint, projectId],
    );
    if (existing.rows[0]) return this.channelOut(existing.rows[0]);

    const now = new Date().toISOString();
    const governance = normalizeSourceConnectionCreateGovernance(identity, {
      ...body,
      connector_type: provider.connector_type,
      policy: body.policy ?? {},
      consent: body.consent ?? {},
      capture_policy: body.capture_policy ?? "reference_only",
    });
    const connection = await this.ensureConnection(identity, provider, sourceName, governance, body);
    const channelResult = await this.db.query<SourceChannelRow>(
      `INSERT INTO source_channels (
         id, space_id, source_connection_id, created_by_user_id, name, channel_type,
         endpoint_url, query_json, provider_query_json, query_fingerprint, status,
         fetch_frequency, schedule_rule_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$14)
       RETURNING *`,
      [
        randomUUID(), identity.spaceId, connection.id, identity.userId, name.slice(0, 512),
        channelType(provider.connector_key), compiled.endpointUrl,
        compiledResearch ? null : JSON.stringify(compiled.query), compiledResearch ? null : JSON.stringify(compiled.providerQuery),
        compiledResearch ? null : fingerprint,
        status, frequency, JSON.stringify(schedule.rule), now,
      ],
    );
    const channel = channelResult.rows[0]!;
    if (compiledResearch) {
      await this.db.query(
        `INSERT INTO source_search_specs
          (id,space_id,source_channel_id,provider_key,research_query_attempt_id,
           compiled_provider_query_json,query_fingerprint,active_version,activated_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6,1,$7,$7,$7)`,
        [randomUUID(), identity.spaceId, channel.id, researchProviderKey, JSON.stringify(compiledResearch.query), compiledResearch.fingerprint, now],
      );
    }
    await this.db.query(
      `INSERT INTO source_channel_user_subscriptions (
         id, space_id, source_channel_id, user_id, status, library_enabled, digest_enabled, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)
       ON CONFLICT (space_id, source_channel_id, user_id) DO UPDATE SET status='subscribed', updated_at=EXCLUDED.updated_at`,
      [randomUUID(), identity.spaceId, channel.id, identity.userId, now],
    );
    await upsertSourceChannelScanTask(this.db, {
      channel: { id: channel.id, space_id: identity.spaceId, owner_user_id: identity.userId, status, fetch_frequency: frequency },
      nextRunAt: schedule.nextRunAt,
      updatedAt: now,
    });
    return this.channelOut({
      ...channel,
      source_name: sourceName,
      provider_key: provider.provider_key,
      provider_display_name: provider.provider_display_name,
      connector_key: provider.connector_key,
      connector_mapping_id: provider.mapping_id,
      connection_status: connection.status,
      capture_policy: governance.capturePolicy,
      search_spec_provider_query_json: compiledResearch?.query,
      search_spec_query_fingerprint: compiledResearch?.fingerprint,
    });
  }

  /** Materialize a selected research attempt without recompiling or rewriting its query. */
  async createFromSelectedResearchAttempt(identity: SpaceUserIdentity, input: SelectedResearchAttemptChannelInput) {
    return withQueryableTransaction(this.db, (db) =>
      new SourceChannelService(db, this.config).createFromSelectedResearchAttemptLocked(identity, input));
  }

  private async createFromSelectedResearchAttemptLocked(identity: SpaceUserIdentity, input: SelectedResearchAttemptChannelInput) {
    if (input.compiledQuery.provider_key !== input.providerKey) {
      throw new HttpError(422, "Selected attempt provider does not match its compiled query");
    }
    const existing = await this.db.query<SourceChannelRow>(
      `${this.selectSql()} WHERE ch.space_id=$1 AND ss.research_query_attempt_id=$2 LIMIT 1`,
      [identity.spaceId, input.attemptId],
    );
    if (existing.rows[0]) return this.channelOut(existing.rows[0]);

    const provider = await this.catalog.resolve(input.providerKey);
    if (input.credentialId) {
      await new CustomSourceCredentialService(this.db, this.config).requireOwnCredential(identity, input.credentialId);
    }
    const now = new Date().toISOString();
    const sourceName = provider.provider_display_name;
    const governance = normalizeSourceConnectionCreateGovernance(identity, {
      connector_type: provider.connector_type,
      policy: {},
      consent: {},
      capture_policy: "reference_only",
    });
    const connection = await this.ensureConnection(identity, provider, sourceName, governance, {
      credential_id: input.credentialId,
    });
    const channelId = randomUUID();
    const name = input.name ?? this.defaultName(input.providerKey, input.compiledQuery.query);
    const schedule = resolveChannelSchedule({}, "daily", "active");
    const channelResult = await this.db.query<SourceChannelRow>(
      `INSERT INTO source_channels (
         id,space_id,source_connection_id,created_by_user_id,name,channel_type,
         endpoint_url,query_json,provider_query_json,query_fingerprint,status,
         fetch_frequency,schedule_rule_json,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'search',NULL,NULL,NULL,NULL,'active','daily',$6::jsonb,$7,$7)
       RETURNING *`,
      [channelId, identity.spaceId, connection.id, identity.userId, name.slice(0, 512), JSON.stringify(schedule.rule), now],
    );
    await this.db.query(
      `INSERT INTO source_search_specs (
         id,space_id,source_channel_id,provider_key,research_query_attempt_id,
         compiled_provider_query_json,query_fingerprint,active_version,activated_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8,$8,$8)`,
      [randomUUID(), identity.spaceId, channelId, input.providerKey, input.attemptId, JSON.stringify(input.compiledQuery.query), input.compiledQuery.fingerprint, now],
    );
    await this.db.query(
      `INSERT INTO source_channel_user_subscriptions (
         id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)
       ON CONFLICT (space_id,source_channel_id,user_id) DO UPDATE SET status='subscribed',updated_at=EXCLUDED.updated_at`,
      [randomUUID(), identity.spaceId, channelId, identity.userId, now],
    );
    await upsertSourceChannelScanTask(this.db, {
      channel: { id: channelId, space_id: identity.spaceId, owner_user_id: identity.userId, status: "active", fetch_frequency: "daily" },
      nextRunAt: schedule.nextRunAt,
      updatedAt: now,
    });
    return this.channelOut({
      ...channelResult.rows[0]!,
      source_name: sourceName,
      provider_key: provider.provider_key,
      provider_display_name: provider.provider_display_name,
      connector_key: provider.connector_key,
      connector_mapping_id: provider.mapping_id,
      connection_status: connection.status,
      capture_policy: governance.capturePolicy,
      search_spec_provider_query_json: input.compiledQuery.query,
      search_spec_query_fingerprint: input.compiledQuery.fingerprint,
      research_query_attempt_id: input.attemptId,
    });
  }

  async proposeActivation(identity: SpaceUserIdentity, body: Record<string, unknown>, actor: SourceChannelProposalActor = {}) {
    const channel = await this.create(identity, { ...body, status: "paused", _initial_status: "paused" });
    const channelId = requiredString(channel.id, "source_channel_id");
    const existing = actor.runId && actor.idempotencyKey
      ? await this.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM proposals
          WHERE space_id=$1 AND created_by_run_id=$2
            AND proposal_type='source_channel_activation'
            AND action_idempotency_key=$3`,
        [identity.spaceId, actor.runId, actor.idempotencyKey],
      )
      : { rows: [] as Array<{ id: string; status: string }> };
    if (existing.rows[0]) {
      return { channel, proposal: existing.rows[0], auto_applied: existing.rows[0].status === "accepted" };
    }
    const proposal = await insertProposalRow(this.db, {
      spaceId: identity.spaceId,
      proposalType: "source_channel_activation",
      title: `Activate Source Channel: ${String(channel.name ?? "channel")}`,
      payload: {
        proposal_type: "source_channel_activation",
        action_id: "source.channel.propose_activation",
        source_channel_id: channelId,
        draft_updated_at: requiredString(channel.updated_at, "draft_updated_at"),
        ...(actor.idempotencyKey ? { idempotency_key: actor.idempotencyKey } : {}),
      },
      rationale: "Activate a reviewed Source Channel and its underlying governed connection.",
      createdByUserId: actor.agentId ? null : identity.userId,
      createdByAgentId: actor.agentId ?? null,
      createdByRunId: actor.runId ?? null,
      actionIdempotencyKey: actor.idempotencyKey ?? null,
      projectId: actor.projectId ?? null,
      visibility: "space_shared",
      riskLevel: "medium",
      requiredApproverRole: "owner",
    });
    const autoApplied = actor.agentId
      ? await PgProposalApplyService.fromConfig(this.config).acceptAgentProposalIfGranted(proposal.id, {
        actionId: "source.channel.propose_activation",
        resourceKind: "source_channel",
        resourceId: channelId,
      })
      : null;
    return { channel, proposal: autoApplied?.proposal ?? proposal, auto_applied: Boolean(autoApplied) };
  }

  async update(identity: SpaceUserIdentity, channelId: string, body: Record<string, unknown>) {
    const current = await this.getRaw(identity, channelId);
    if (!current) throw new HttpError(404, "Source channel not found");
    const frequency = optionalString(body.fetch_frequency) ?? current.fetch_frequency;
    if (!["manual", "hourly", "daily", "weekly"].includes(frequency)) throw new HttpError(422, "Invalid fetch_frequency");
    const status = optionalString(body.status) ?? current.status;
    if (!["active", "paused", "archived"].includes(status)) throw new HttpError(422, "Invalid channel status");
    const schedule = resolveChannelSchedule(body, frequency, status, current.schedule_rule_json);
    if (current.search_spec_query_fingerprint && (body.query !== undefined || body.endpoint_url !== undefined)) {
      throw new HttpError(409, "Search query configuration is versioned and cannot be edited in place; create a new monitor version");
    }
    let queryJson = current.query_json;
    let providerQueryJson = current.provider_query_json;
    let endpointUrl = current.endpoint_url;
    let fingerprint = current.query_fingerprint;
    if (body.query !== undefined || body.endpoint_url !== undefined) {
      if (!current.connector_key || !current.provider_key) throw new HttpError(409, "Source channel provider mapping is unavailable");
      const query = objectValue(body.query ?? current.query_json);
      const compiled = normalizeNonSearchChannel(current.connector_key, {
        ...query, endpoint_url: optionalString(body.endpoint_url) ?? current.endpoint_url ?? optionalString(query.endpoint_url), query,
      });
      queryJson = compiled.query;
      providerQueryJson = compiled.providerQuery;
      endpointUrl = compiled.endpointUrl;
      fingerprint = genericChannelFingerprint(current.provider_key, current.connector_key, compiled.endpointUrl);
    }
    const result = await this.db.query<SourceChannelRow>(
      `UPDATE source_channels SET name=COALESCE($3,name), endpoint_url=$4, query_json=$5::jsonb, provider_query_json=$6::jsonb, query_fingerprint=$7, status=$8, fetch_frequency=$9, schedule_rule_json=$10::jsonb, updated_at=$11
        WHERE space_id=$1 AND id=$2 RETURNING *`,
      [identity.spaceId, channelId, optionalString(body.name), endpointUrl, jsonbParameter(queryJson), jsonbParameter(providerQueryJson), fingerprint, status, frequency, JSON.stringify(schedule.rule), new Date().toISOString()],
    );
    const row = result.rows[0]!;
    const sourceName = optionalString(body.source_name);
    if (sourceName) {
      await this.db.query(
        `UPDATE source_connections SET name=$3, updated_at=$4
           WHERE space_id=$1 AND id=(SELECT source_connection_id FROM source_channels WHERE space_id=$1 AND id=$2)`,
        [identity.spaceId, channelId, sourceName, new Date().toISOString()],
      );
    }
    await upsertSourceChannelScanTask(this.db, { channel: { id: row.id, space_id: row.space_id, owner_user_id: identity.userId, status: row.status, fetch_frequency: row.fetch_frequency }, nextRunAt: schedule.nextRunAt, updatedAt: row.updated_at as string });
    return this.get(identity, channelId);
  }

  async scan(identity: SpaceUserIdentity, channelId: string) {
    const channel = await this.getRaw(identity, channelId);
    if (!channel) throw new HttpError(404, "Source channel not found");
    const result = await this.db.query(
      `INSERT INTO extraction_jobs (id, space_id, connection_id, source_item_id, job_type, status, metadata_json, created_at)
       VALUES ($1,$2,$3,NULL,'connection_scan','pending',$4::jsonb,$5)
       RETURNING id, space_id, connection_id, job_type, status, metadata_json, created_at`,
      [randomUUID(), identity.spaceId, channel.source_connection_id, JSON.stringify({ source_channel_id: channelId, created_by: "manual_scan" }), new Date().toISOString()],
    );
    return result.rows[0];
  }

  private async ensureConnection(identity: SpaceUserIdentity, provider: ResolvedSourceProviderConnector, name: string, governance: ReturnType<typeof normalizeSourceConnectionCreateGovernance>, body: Record<string, unknown>) {
    const projectId = optionalString(body.project_id);
    const visibility = optionalString(body.visibility) ?? "private";
    const existing = body._force_create === true
      ? { rows: [] as Array<{ id: string; status: string }> }
      : await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM source_connections
        WHERE space_id=$1 AND owner_user_id=$2 AND provider_connector_id=$3
          AND project_id IS NOT DISTINCT FROM $4
          AND deleted_at IS NULL AND status <> 'archived'
        ORDER BY updated_at DESC LIMIT 1`,
      [identity.spaceId, identity.userId, provider.mapping_id, projectId],
    );
    if (existing.rows[0]) return existing.rows[0];
    const now = new Date().toISOString();
    const result = await this.db.query<{ id: string; status: string }>(
      `INSERT INTO source_connections (
         id, space_id, project_id, provider_connector_id, owner_user_id, credential_id, visibility, access_level, name,
         status, capture_policy, trust_level, topic_hints_json, consent_json, policy_json, config_json,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'full',$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$16)
       ON CONFLICT DO NOTHING
       RETURNING id, status`,
      [
        randomUUID(), identity.spaceId, projectId, provider.mapping_id, identity.userId, optionalString(body.credential_id), visibility, name,
        body._initial_status === "paused" ? "paused" : "active", governance.capturePolicy, governance.trustLevel,
        JSON.stringify(Array.isArray(body.topic_hints) ? body.topic_hints : []), JSON.stringify(governance.consent), JSON.stringify(governance.policy), JSON.stringify(objectValue(body.transport_config ?? body.config)), now,
      ],
    );
    if (result.rows[0]) return result.rows[0];
    const concurrent = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM source_connections
        WHERE space_id=$1 AND owner_user_id=$2 AND provider_connector_id=$3
          AND project_id IS NOT DISTINCT FROM $4
          AND deleted_at IS NULL AND status <> 'archived'
        ORDER BY updated_at DESC LIMIT 1`,
      [identity.spaceId, identity.userId, provider.mapping_id, projectId],
    );
    if (!concurrent.rows[0]) throw new HttpError(409, "Source connection could not be created");
    return concurrent.rows[0];
  }

  private async getRaw(identity: SpaceUserIdentity, channelId: string) {
    const result = await this.db.query<SourceChannelRow>(`${this.selectSql()} WHERE ch.space_id=$1 AND ch.id=$2 AND ch.created_by_user_id=$3 LIMIT 1`, [identity.spaceId, channelId, identity.userId]);
    return result.rows[0] ?? null;
  }

  private selectSql() {
    return `SELECT ch.*, p.provider_key, p.display_name AS provider_display_name, c.connector_key,
                   spc.id AS connector_mapping_id, sc.name AS source_name, sc.status AS connection_status,
                   sc.capture_policy, sc.visibility AS connection_visibility,
                   st.status AS scan_status, st.metadata_json AS scan_metadata_json,
                   st.next_run_at AS scan_next_run_at, st.last_run_at AS scan_last_run_at,
                   ss.compiled_provider_query_json AS search_spec_provider_query_json,
                   ss.query_fingerprint AS search_spec_query_fingerprint,
                   ss.research_query_attempt_id
              FROM source_channels ch
              JOIN source_connections sc ON sc.id=ch.source_connection_id
              JOIN source_provider_connectors spc ON spc.id=sc.provider_connector_id
              JOIN source_providers p ON p.id=spc.provider_id
              JOIN source_connectors c ON c.id=spc.connector_id
              LEFT JOIN source_search_specs ss ON ss.source_channel_id=ch.id AND ss.space_id=ch.space_id
              LEFT JOIN scheduler_tasks st
                ON st.task_type='source_channel_scan' AND st.task_key=ch.id AND st.space_id=ch.space_id`;
  }

  private channelOut(row: SourceChannelRow) {
    return {
      id: row.id,
      space_id: row.space_id,
      source_connection_id: row.source_connection_id,
      source_name: row.source_name ?? row.provider_display_name ?? "Source",
      name: row.name,
      channel_type: row.channel_type,
      endpoint_url: row.endpoint_url,
      query: row.channel_type === "search"
        ? objectValue(row.search_spec_provider_query_json)
        : objectValue(row.query_json),
      provider_query: row.channel_type === "search"
        ? objectValue(row.search_spec_provider_query_json)
        : objectValue(row.provider_query_json),
      query_fingerprint: row.channel_type === "search"
        ? row.search_spec_query_fingerprint
        : row.query_fingerprint,
      research_query_attempt_id: row.research_query_attempt_id ?? null,
      status: row.status,
      fetch_frequency: row.fetch_frequency,
      schedule_rule: row.schedule_rule_json ?? null,
      provider: { key: row.provider_key ?? null, display_name: row.provider_display_name ?? null },
      connection_status: row.connection_status ?? null,
      capture_policy: row.capture_policy ?? null,
      scan_state: {
        status: row.scan_status ?? null,
        cursor: objectValue(objectValue(row.scan_metadata_json).cursor),
        watermark: objectValue(objectValue(row.scan_metadata_json).watermark),
        next_run_at: row.scan_next_run_at ?? null,
        last_run_at: row.scan_last_run_at ?? null,
      },
      created_by_user_id: row.created_by_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private defaultName(providerKey: string, query: Record<string, unknown>) {
    if (providerKey === "arxiv") {
      if (query.mode === "all") return "All arXiv papers";
      return String(query.search_query ?? query.categories ?? "search").slice(0, 180).trim();
    }
    if (providerKey === "openalex") return String(query.search ?? "OpenAlex search").slice(0, 180).trim();
    if (providerKey === "semantic_scholar") return String(query.query ?? "Semantic Scholar search").slice(0, 180).trim();
    if (providerKey === "web_search") return String(query.q ?? "Web search").slice(0, 180).trim();
    return "channel";
  }
}

function jsonbParameter(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function channelType(connectorKey: string): string {
  if (["arxiv_api", "openalex_api", "semantic_scholar_api", "brave_web_search_api"].includes(connectorKey)) return "search";
  if (connectorKey === "rss" || connectorKey === "atom") return "feed";
  if (connectorKey === "web_page") return "web_page";
  return "custom_source";
}

function researchProviderForConnector(connectorKey: string): ResearchProviderKey | null {
  if (connectorKey === "arxiv_api") return "arxiv";
  if (connectorKey === "openalex_api") return "openalex";
  if (connectorKey === "semantic_scholar_api") return "semantic_scholar";
  if (connectorKey === "brave_web_search_api") return "web_search";
  return null;
}

function normalizeNonSearchChannel(connectorKey: string, input: Record<string, unknown>) {
  const endpointUrl = optionalString(input.endpoint_url);
  if (!endpointUrl) throw new HttpError(422, `${connectorKey} channel requires endpoint_url`);
  try { new URL(endpointUrl); } catch { throw new HttpError(422, "endpoint_url must be a valid URL"); }
  return { query: {}, providerQuery: {}, endpointUrl };
}

function genericChannelFingerprint(providerKey: string, connectorKey: string, endpointUrl: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ connector: connectorKey, endpoint: endpointUrl, provider: providerKey }))
    .digest("hex");
}

function resolveChannelSchedule(body: Record<string, unknown>, frequency: string, status: string, existingRule?: unknown): { nextRunAt: string | null; rule: SourceScheduleRule | null } {
  if (frequency === "manual" || status !== "active") return { nextRunAt: null, rule: null };
  const raw = body.schedule_rule && typeof body.schedule_rule === "object" ? body.schedule_rule as Record<string, unknown> : null;
  const now = new Date();
  if (raw) {
    const rule = normalizeRule(raw, frequency);
    return { nextRunAt: computeNextRunAtFromScheduleRule(rule, now), rule };
  }
  if (existingRule && typeof existingRule === "object") {
    const rule = normalizeRule(existingRule as Record<string, unknown>, frequency);
    return { nextRunAt: computeNextRunAtFromScheduleRule(rule, now), rule };
  }
  const rule = frequency === "hourly"
    ? { frequency: "hourly", minute: 0 } as const
    : frequency === "weekly"
      ? { frequency: "weekly", weekday: 1, hour: 3, minute: 0 } as const
      : { frequency: "daily", hour: 3, minute: 0 } as const;
  return { nextRunAt: computeNextRunAtFromScheduleRule(rule, now), rule };
}

function normalizeRule(raw: Record<string, unknown>, frequency: string): SourceScheduleRule {
  if (raw.frequency !== frequency) throw new HttpError(422, "schedule_rule.frequency must match fetch_frequency");
  const number = (key: string, min: number, max: number) => {
    const value = Number(raw[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(422, `schedule_rule.${key} is invalid`);
    return value;
  };
  if (frequency === "hourly") return { frequency: "hourly", minute: number("minute", 0, 59) };
  if (frequency === "daily") return { frequency: "daily", hour: number("hour", 0, 23), minute: number("minute", 0, 59) };
  return { frequency: "weekly", weekday: number("weekday", 1, 7), hour: number("hour", 0, 23), minute: number("minute", 0, 59) };
}
