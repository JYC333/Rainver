import type {
  ContextOpsReviewMode,
  ContextOpsScanMode,
  RetrievalCalibrationMechanic,
  RetrievalRuntimeRankingConfig,
  RetrievalSearchMode,
  RetrievalToolMode,
  SpaceRetrievalSettingsUpdate,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { withQueryableTransaction } from "../routeUtils/common";
import {
  ScopedSettingsStore,
  SETTINGS_KEYS,
  defineScopedSetting,
  settingsRecord,
  type ScopedSettingsRead,
} from "../settings";
import { RetrievalEmbeddingStore } from "./embeddingStore";
import { DEFAULT_EMBED_DIMENSIONS } from "./embedding/config";
import {
  contentReadSql,
  contentVisibilityFilterSql,
} from "../access/contentAccessSql";

export interface SpaceRetrievalSettingsOut {
  space_id: string;
  default_search_mode: RetrievalSearchMode;
  rerank_enabled: boolean;
  query_rewrite_enabled: boolean;
  query_rewrite_default: boolean;
  use_query_cache: boolean;
  include_trace: boolean;
  external_egress_enabled: boolean;
  retrieval_tool_mode: RetrievalToolMode;
  context_ops_review_mode: ContextOpsReviewMode;
  context_ops_scan_mode: ContextOpsScanMode;
  embedding_dimensions: number;
  max_results_default: number;
  ranking_config: RetrievalRuntimeRankingConfig;
  created_at: string;
  updated_at: string;
}

export interface ResolvedSpaceRetrievalSettings {
  defaultSearchMode: RetrievalSearchMode;
  rerankEnabled: boolean;
  queryRewriteEnabled: boolean;
  queryRewriteDefault: boolean;
  useQueryCache: boolean;
  includeTrace: boolean;
  externalEgressEnabled: boolean;
  retrievalToolMode: RetrievalToolMode;
  contextOpsReviewMode: ContextOpsReviewMode;
  contextOpsScanMode: ContextOpsScanMode;
  embeddingDimensions: number;
  maxResultsDefault: number;
  rankingConfig: RetrievalRuntimeRankingConfig;
}

export interface ResolvedRetrievalSearchControls {
  mode: RetrievalSearchMode;
  rewrite: boolean;
  useCache: boolean;
  includeTrace: boolean;
  adaptiveReturn: boolean;
  maxResults: number;
  rankingConfig: RetrievalRuntimeRankingConfig;
}

export interface RetrievalControlRequest {
  mode?: RetrievalSearchMode;
  rewrite?: boolean;
  use_cache?: boolean;
  include_trace?: boolean;
  adaptive_return?: boolean;
  max_results?: number;
}

export const SPACE_RETRIEVAL_SETTINGS_KEY = SETTINGS_KEYS.retrievalSpace;

const RETRIEVAL_SEARCH_MODES: readonly RetrievalSearchMode[] = ["exact", "lexical", "hybrid", "hybrid_rerank"];
const RETRIEVAL_TOOL_MODES: readonly RetrievalToolMode[] = [
  "off",
  "manual_tool_only",
  "preflight_search",
  "preflight_brief",
];
const CONTEXT_OPS_REVIEW_MODES: readonly ContextOpsReviewMode[] = ["private_only", "admins", "members"];
const CONTEXT_OPS_SCAN_MODES: readonly ContextOpsScanMode[] = ["admins", "members"];

type ShippableRetrievalMechanic = Exclude<RetrievalCalibrationMechanic, "semantic_results_cache">;

const SHIPPABLE_RETRIEVAL_MECHANICS: readonly ShippableRetrievalMechanic[] = [
  "visible_edge_backlink",
  "candidate_owned_salience",
  "richer_dedup",
  "autocut",
];

const ALL_RETRIEVAL_MECHANICS: readonly RetrievalCalibrationMechanic[] = [
  ...SHIPPABLE_RETRIEVAL_MECHANICS,
  "semantic_results_cache",
];

type RuntimeMechanicConfig = RetrievalRuntimeRankingConfig["mechanics"][RetrievalCalibrationMechanic];

export const DEFAULT_RETRIEVAL_RANKING_CONFIG: RetrievalRuntimeRankingConfig = {
  version: 1,
  eval_gate: {
    min_primary_metric_delta: 0,
    required_evidence_artifacts: 1,
  },
  mechanics: {
    visible_edge_backlink: defaultRuntimeMechanic(),
    candidate_owned_salience: defaultRuntimeMechanic(),
    richer_dedup: defaultRuntimeMechanic(),
    autocut: defaultRuntimeMechanic(),
    semantic_results_cache: defaultRuntimeMechanic(),
  },
};

export const DEFAULT_SPACE_RETRIEVAL_SETTINGS: ResolvedSpaceRetrievalSettings = {
  defaultSearchMode: "hybrid",
  rerankEnabled: false,
  queryRewriteEnabled: false,
  queryRewriteDefault: false,
  useQueryCache: true,
  includeTrace: false,
  externalEgressEnabled: true,
  retrievalToolMode: "off",
  contextOpsReviewMode: "private_only",
  contextOpsScanMode: "admins",
  embeddingDimensions: DEFAULT_EMBED_DIMENSIONS,
  maxResultsDefault: 50,
  rankingConfig: DEFAULT_RETRIEVAL_RANKING_CONFIG,
};

const SPACE_RETRIEVAL_SETTINGS_DEFINITION = defineScopedSetting<ResolvedSpaceRetrievalSettings>({
  key: SPACE_RETRIEVAL_SETTINGS_KEY,
  scopeType: "space",
  defaults: DEFAULT_SPACE_RETRIEVAL_SETTINGS,
  parse: parseRetrievalSettings,
  serialize: retrievalSettingsJson,
});

export async function readSpaceRetrievalSettings(
  db: Queryable,
  spaceId: string,
): Promise<ResolvedSpaceRetrievalSettings> {
  return (await new ScopedSettingsStore(db).get(SPACE_RETRIEVAL_SETTINGS_DEFINITION, spaceId)).value;
}

export async function getOrCreateSpaceRetrievalSettings(
  db: Queryable,
  spaceId: string,
): Promise<SpaceRetrievalSettingsOut> {
  const read = await new ScopedSettingsStore(db).getOrCreate(SPACE_RETRIEVAL_SETTINGS_DEFINITION, spaceId);
  if (!read.row) throw new Error("space retrieval settings row was not created");
  return outFromRead(spaceId, read);
}

export async function updateSpaceRetrievalSettings(
  db: Queryable,
  spaceId: string,
  patch: SpaceRetrievalSettingsUpdate,
  options: { actorUserId?: string | null } = {},
): Promise<SpaceRetrievalSettingsOut> {
  return withQueryableTransaction(db, async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`runtime-egress-settings:${spaceId}`]);
    const store = new ScopedSettingsStore(transaction);
    const current = await store.getOrCreate(SPACE_RETRIEVAL_SETTINGS_DEFINITION, spaceId);
    const next = {
      defaultSearchMode: patch.default_search_mode ?? current.value.defaultSearchMode,
      rerankEnabled: patch.rerank_enabled ?? current.value.rerankEnabled,
      queryRewriteEnabled: patch.query_rewrite_enabled ?? current.value.queryRewriteEnabled,
      queryRewriteDefault: patch.query_rewrite_default ?? current.value.queryRewriteDefault,
      useQueryCache: patch.use_query_cache ?? current.value.useQueryCache,
      includeTrace: patch.include_trace ?? current.value.includeTrace,
      externalEgressEnabled: patch.external_egress_enabled ?? current.value.externalEgressEnabled,
      retrievalToolMode: patch.retrieval_tool_mode ?? current.value.retrievalToolMode,
      contextOpsReviewMode: patch.context_ops_review_mode ?? current.value.contextOpsReviewMode,
      contextOpsScanMode: patch.context_ops_scan_mode ?? current.value.contextOpsScanMode,
      embeddingDimensions: patch.embedding_dimensions ?? current.value.embeddingDimensions,
      maxResultsDefault: patch.max_results_default ?? current.value.maxResultsDefault,
      rankingConfig: await normalizeRankingConfigForUpdate(
        transaction,
        spaceId,
        patch.ranking_config ?? current.value.rankingConfig,
        options.actorUserId ?? null,
      ),
    };
    if (next.externalEgressEnabled !== current.value.externalEgressEnabled) {
      await transaction.query(
        `INSERT INTO settings (
           id,scope_type,scope_id,settings_key,settings_json,updated_by_user_id,created_at,updated_at
         ) VALUES ($1,'space',$2,$3,'{"generation":1}'::jsonb,$4,now(),now())
         ON CONFLICT (scope_type,scope_id,settings_key)
         DO UPDATE SET settings_json=jsonb_build_object(
           'generation',COALESCE((settings.settings_json->>'generation')::int,0)+1
         ),updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [randomUUID(), spaceId, SETTINGS_KEYS.runtimeContextCliEgressGeneration,
          options.actorUserId ?? null],
      );
    }
    const updated = await store.upsert(SPACE_RETRIEVAL_SETTINGS_DEFINITION, spaceId, next, {
      updatedByUserId: options.actorUserId ?? null,
    });
    if (next.embeddingDimensions !== current.value.embeddingDimensions) {
      await new RetrievalEmbeddingStore(transaction).resetEmbeddingsForSpace(spaceId);
    }
    return outFromRead(spaceId, updated);
  });
}

export function resolveRetrievalSearchControls(
  request: RetrievalControlRequest,
  settings: ResolvedSpaceRetrievalSettings,
): ResolvedRetrievalSearchControls {
  return {
    mode: request.mode ?? settings.defaultSearchMode,
    rewrite: request.rewrite ?? settings.queryRewriteDefault,
    useCache: request.use_cache ?? settings.useQueryCache,
    includeTrace: request.include_trace ?? settings.includeTrace,
    adaptiveReturn: request.adaptive_return ?? isRetrievalMechanicShipped(settings.rankingConfig, "autocut"),
    maxResults: request.max_results ?? settings.maxResultsDefault,
    rankingConfig: settings.rankingConfig,
  };
}

function retrievalSettingsJson(settings: ResolvedSpaceRetrievalSettings): Record<string, unknown> {
  return {
    default_search_mode: settings.defaultSearchMode,
    rerank_enabled: settings.rerankEnabled,
    query_rewrite_enabled: settings.queryRewriteEnabled,
    query_rewrite_default: settings.queryRewriteDefault,
    use_query_cache: settings.useQueryCache,
    include_trace: settings.includeTrace,
    external_egress_enabled: settings.externalEgressEnabled,
    retrieval_tool_mode: settings.retrievalToolMode,
    context_ops_review_mode: settings.contextOpsReviewMode,
    context_ops_scan_mode: settings.contextOpsScanMode,
    embedding_dimensions: settings.embeddingDimensions,
    max_results_default: settings.maxResultsDefault,
    ranking_config: settings.rankingConfig,
  };
}

function parseRetrievalSettings(value: unknown): ResolvedSpaceRetrievalSettings {
  const settings = settingsRecord(value);
  return {
    defaultSearchMode: enumValue(
      settings.default_search_mode,
      RETRIEVAL_SEARCH_MODES,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.defaultSearchMode,
    ),
    rerankEnabled: boolValue(settings.rerank_enabled, DEFAULT_SPACE_RETRIEVAL_SETTINGS.rerankEnabled),
    queryRewriteEnabled: boolValue(
      settings.query_rewrite_enabled,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.queryRewriteEnabled,
    ),
    queryRewriteDefault: boolValue(
      settings.query_rewrite_default,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.queryRewriteDefault,
    ),
    useQueryCache: boolValue(settings.use_query_cache, DEFAULT_SPACE_RETRIEVAL_SETTINGS.useQueryCache),
    includeTrace: boolValue(settings.include_trace, DEFAULT_SPACE_RETRIEVAL_SETTINGS.includeTrace),
    externalEgressEnabled: boolValue(
      settings.external_egress_enabled,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.externalEgressEnabled,
    ),
    retrievalToolMode: enumValue(
      settings.retrieval_tool_mode,
      RETRIEVAL_TOOL_MODES,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.retrievalToolMode,
    ),
    contextOpsReviewMode: enumValue(
      settings.context_ops_review_mode,
      CONTEXT_OPS_REVIEW_MODES,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.contextOpsReviewMode,
    ),
    contextOpsScanMode: enumValue(
      settings.context_ops_scan_mode,
      CONTEXT_OPS_SCAN_MODES,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.contextOpsScanMode,
    ),
    embeddingDimensions: intBounded(
      settings.embedding_dimensions,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.embeddingDimensions,
      64,
      4096,
    ),
    maxResultsDefault: intBounded(
      settings.max_results_default,
      DEFAULT_SPACE_RETRIEVAL_SETTINGS.maxResultsDefault,
      1,
      50,
    ),
    rankingConfig: normalizeRuntimeRankingConfig(settings.ranking_config ?? DEFAULT_RETRIEVAL_RANKING_CONFIG),
  };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = intValue(value, fallback);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function outFromRead(
  spaceId: string,
  read: ScopedSettingsRead<ResolvedSpaceRetrievalSettings>,
): SpaceRetrievalSettingsOut {
  if (!read.row) throw new Error("space retrieval settings row was not created");
  return {
    space_id: spaceId,
    default_search_mode: read.value.defaultSearchMode,
    rerank_enabled: read.value.rerankEnabled,
    query_rewrite_enabled: read.value.queryRewriteEnabled,
    query_rewrite_default: read.value.queryRewriteDefault,
    use_query_cache: read.value.useQueryCache,
    include_trace: read.value.includeTrace,
    external_egress_enabled: read.value.externalEgressEnabled,
    retrieval_tool_mode: read.value.retrievalToolMode,
    context_ops_review_mode: read.value.contextOpsReviewMode,
    context_ops_scan_mode: read.value.contextOpsScanMode,
    embedding_dimensions: read.value.embeddingDimensions,
    max_results_default: read.value.maxResultsDefault,
    ranking_config: read.value.rankingConfig,
    created_at: asIso(read.row.created_at as Date | string),
    updated_at: asIso(read.row.updated_at as Date | string),
  };
}

export function normalizeRuntimeRankingConfig(value: unknown): RetrievalRuntimeRankingConfig {
  const root = record(value);
  const gate = record(root.eval_gate);
  const mechanics = record(root.mechanics);
  const normalized: RetrievalRuntimeRankingConfig = {
    version: 1,
    eval_gate: {
      min_primary_metric_delta: finiteNumber(gate.min_primary_metric_delta) ?? 0,
      required_evidence_artifacts: Math.max(0, Math.min(12, intValue(gate.required_evidence_artifacts, 1))),
    },
    mechanics: {
      visible_edge_backlink: normalizeMechanic(mechanics.visible_edge_backlink),
      candidate_owned_salience: normalizeMechanic(mechanics.candidate_owned_salience),
      richer_dedup: normalizeMechanic(mechanics.richer_dedup),
      autocut: normalizeMechanic(mechanics.autocut),
      semantic_results_cache: { ...normalizeMechanic(mechanics.semantic_results_cache), state: "disabled" },
    },
  };
  return normalized;
}

export function isRetrievalMechanicShipped(
  config: RetrievalRuntimeRankingConfig,
  mechanic: ShippableRetrievalMechanic,
): boolean {
  return normalizeRuntimeRankingConfig(config).mechanics[mechanic].state === "shipped";
}

async function normalizeRankingConfigForUpdate(
  db: Queryable,
  spaceId: string,
  value: unknown,
  actorUserId: string | null,
): Promise<RetrievalRuntimeRankingConfig> {
  const normalized = normalizeRuntimeRankingConfig(value);
  const checkedAt = new Date().toISOString();
  for (const mechanic of ALL_RETRIEVAL_MECHANICS) {
    const config = normalized.mechanics[mechanic];
    if (mechanic === "semantic_results_cache") {
      config.state = "disabled";
      config.calibration_artifact_id = null;
      config.shipped_at = null;
      config.eval_gate = { status: "failed", metric: null, value: null, threshold: normalized.eval_gate.min_primary_metric_delta, checked_at: checkedAt };
      continue;
    }
    if (config.state === "disabled") {
      config.shipped_at = null;
      if (!config.calibration_artifact_id) config.eval_gate = defaultRuntimeMechanic().eval_gate;
      continue;
    }
    if (!config.calibration_artifact_id) {
      throw new SpaceRetrievalSettingsError(`${mechanic} requires calibration_artifact_id before it can be ${config.state}`);
    }
    if (!actorUserId) {
      throw new SpaceRetrievalSettingsError("actor_user_id is required to use a calibration artifact");
    }
    const gate = await evaluateCalibrationGate(db, {
      spaceId,
      actorUserId,
      mechanic,
      calibrationArtifactId: config.calibration_artifact_id,
      minDelta: normalized.eval_gate.min_primary_metric_delta,
      requiredEvidence: normalized.eval_gate.required_evidence_artifacts,
      checkedAt,
    });
    config.eval_gate = gate;
    if (config.state === "shipped") {
      if (gate.status !== "passed") {
        throw new SpaceRetrievalSettingsError(`${mechanic} cannot ship until its calibration eval gate passes`);
      }
      config.shipped_at = config.shipped_at ?? checkedAt;
    } else {
      config.shipped_at = null;
    }
  }
  return normalized;
}

async function evaluateCalibrationGate(
  db: Queryable,
  input: {
    spaceId: string;
    actorUserId: string;
    mechanic: ShippableRetrievalMechanic;
    calibrationArtifactId: string;
    minDelta: number;
    requiredEvidence: number;
    checkedAt: string;
  },
): Promise<RuntimeMechanicConfig["eval_gate"]> {
  const result = await db.query<{ metadata_json: unknown }>(
    `SELECT a.metadata_json
       FROM artifacts a
      WHERE a.space_id = $1
        AND a.id = $2
        AND a.artifact_type = 'retrieval_calibration_decision'
        AND ${contentReadSql("artifact", "a", "$3")}
        AND ${contentVisibilityFilterSql("a", ["space_shared"])}
      LIMIT 1`,
    [input.spaceId, input.calibrationArtifactId, input.actorUserId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SpaceRetrievalSettingsError("calibration artifact not found or not visible");
  }
  const metadata = record(row.metadata_json);
  const decision = arrayValue(metadata.decisions)
    .map(record)
    .find((item) =>
      stringValue(item.mechanic) === input.mechanic &&
      stringValue(item.decision) === "adopt"
    );
  if (!decision) {
    throw new SpaceRetrievalSettingsError(`${input.mechanic} requires an adopted calibration decision`);
  }
  const evidenceCount = arrayValue(decision.evidence_artifact_ids).filter((id) => typeof id === "string" && id.trim()).length;
  const evalDelta = record(decision.eval_delta);
  const { metric, value } = bestEvalDelta(evalDelta);
  const passed = evidenceCount >= input.requiredEvidence && value !== null && value >= input.minDelta;
  return {
    status: passed ? "passed" : "failed",
    metric,
    value,
    threshold: input.minDelta,
    checked_at: input.checkedAt,
  };
}

function bestEvalDelta(values: Record<string, unknown>): { metric: string | null; value: number | null } {
  let bestMetric: string | null = null;
  let bestValue: number | null = null;
  for (const [key, raw] of Object.entries(values)) {
    const value = finiteNumber(raw);
    if (value === null) continue;
    if (bestValue === null || value > bestValue) {
      bestMetric = key;
      bestValue = value;
    }
  }
  return { metric: bestMetric, value: bestValue };
}

function defaultRuntimeMechanic(): RuntimeMechanicConfig {
  return {
    state: "disabled",
    calibration_artifact_id: null,
    shipped_at: null,
    eval_gate: {
      status: "not_run",
      metric: null,
      value: null,
      threshold: 0,
      checked_at: null,
    },
  };
}

function normalizeMechanic(value: unknown): RuntimeMechanicConfig {
  const item = record(value);
  const state = stringValue(item.state);
  const gate = record(item.eval_gate);
  return {
    state: state === "adopted" || state === "shipped" ? state : "disabled",
    calibration_artifact_id: stringValue(item.calibration_artifact_id),
    shipped_at: isoOrNull(item.shipped_at),
    eval_gate: {
      status: ["passed", "failed", "not_run"].includes(stringValue(gate.status) ?? "")
        ? stringValue(gate.status) as "passed" | "failed" | "not_run"
        : "not_run",
      metric: stringValue(gate.metric),
      value: finiteNumber(gate.value),
      threshold: finiteNumber(gate.threshold) ?? 0,
      checked_at: isoOrNull(gate.checked_at),
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function intValue(value: unknown, fallback: number): number {
  const numeric = finiteNumber(value);
  return numeric === null ? fallback : Math.trunc(numeric);
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

export class SpaceRetrievalSettingsError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = "SpaceRetrievalSettingsError";
  }
}

function asIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}
