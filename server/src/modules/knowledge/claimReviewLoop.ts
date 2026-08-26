import type {
  ClaimContradictionFinding,
  ClaimContradictionReport,
  ClaimContradictionSignal,
  ClaimTrajectoryPoint,
  ClaimTrajectoryResponse,
  ClaimTrajectorySignal,
} from "@agent-space/protocol";
import { CLAIM_COLUMNS, CLAIM_FROM, type ClaimRow } from "./knowledgeRepositoryRows.js";
import type { Queryable } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import {
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromMetadata,
  sourcePolicyAllowsRead,
} from "../retrieval/sourcePolicy.js";

/**
 * Slice E backend: claim trajectory (advisory, read-only change-over-time
 * signals) and the deterministic, access-safe contradiction-discovery scan.
 *
 * Both only ever read viewer-visible claims (the same readable space-object gate
 * the Knowledge repository uses), so they cannot surface hidden claim existence,
 * counts, or text. Neither writes canonical state: trajectory is pure read; the
 * contradiction scan emits a report whose only path to a canonical write is the
 * proposal-gated Claim Candidate Packet flow.
 */

const CONFIDENCE_TIERS = ["high", "medium", "low"] as const;
type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

function readableClaimClause(userParam: string): string {
  return contentReadSql("space_object", "so", userParam);
}

function readableSpaceObjectClause(alias: string, userParam: string): string {
  return contentReadSql("space_object", alias, userParam);
}

export interface ClaimTrajectoryInput {
  spaceId: string;
  userId: string;
  subjectObjectId?: string | null;
  claimId?: string | null;
  limit: number;
}

export async function buildClaimTrajectory(
  db: Queryable,
  input: ClaimTrajectoryInput,
): Promise<ClaimTrajectoryResponse> {
  const now = new Date().toISOString();
  let subjectObjectId = input.subjectObjectId ?? null;
  let subjectText: string | null = null;

  if (!subjectObjectId && input.claimId) {
    const seed = await loadVisibleClaim(db, input.spaceId, input.userId, input.claimId);
    if (seed) {
      subjectObjectId = seed.subject_object_id;
      subjectText = seed.subject_text;
    }
  }

  const rows = subjectObjectId
    ? await loadVisibleClaimsBySubjectObject(db, input.spaceId, input.userId, subjectObjectId, input.limit)
    : input.claimId
      ? await loadVisibleClaimsBySubjectText(db, input.spaceId, input.userId, subjectText, input.limit)
      : [];
  const sourceAllowedRows = await filterClaimsBySourcePolicy(db, input.spaceId, input.userId, rows);

  if (!subjectText) subjectText = sourceAllowedRows.find((row) => row.subject_text)?.subject_text ?? null;

  const holderLabels = await loadVisibleHolderLabels(
    db,
    input.spaceId,
    input.userId,
    sourceAllowedRows.map((row) => row.holder_object_id),
  );
  const points = sourceAllowedRows
    .map((row) =>
      trajectoryPoint(
        row,
        row.holder_object_id ? holderLabels.get(row.holder_object_id) : null,
      ),
    )
    .sort((a, b) => trajectoryKey(a) - trajectoryKey(b));
  const signals = trajectorySignals(points);

  return {
    generated_at: now,
    space_id: input.spaceId,
    subject_object_id: subjectObjectId,
    subject_text: subjectText,
    points,
    signals,
    access_safety: {
      advisory_only: true,
      only_visible_claims: true,
      raw_private_content_included: false,
      hidden_claim_counts_included: false,
    },
    canonical_write_performed: false,
  };
}

export interface ClaimContradictionScanInput {
  spaceId: string;
  userId: string;
  subjectObjectId?: string | null;
  limit: number;
  maxFindings: number;
  llmJudgeEnabled?: boolean;
  llmJudge?: ClaimContradictionLlmJudge | null;
}

export interface ClaimContradictionJudgeClaim {
  claim_id: string;
  title: string;
  claim_kind: string;
  claim_text: string;
  subject_object_id: string | null;
  subject_text: string | null;
  confidence: number | null;
  source_connection_ids: string[];
}

export interface ClaimContradictionLlmJudge {
  judge(input: {
    spaceId: string;
    userId: string;
    claims: readonly ClaimContradictionJudgeClaim[];
    deterministicFindings: readonly ClaimContradictionFinding[];
    maxFindings: number;
    sourcePolicies: Readonly<Record<string, unknown>>;
    payloadSourceConnectionIds: readonly string[];
  }): Promise<ClaimContradictionFinding[]>;
}

export async function scanClaimContradictions(
  db: Queryable,
  input: ClaimContradictionScanInput,
): Promise<ClaimContradictionReport> {
  const rows = await loadVisibleActiveClaims(
    db,
    input.spaceId,
    input.userId,
    input.subjectObjectId ?? null,
    input.limit,
  );
  const policyFiltered = await filterClaimsBySourcePolicyWithSourceIds(db, input.spaceId, input.userId, rows);
  const sourceAllowedRows = policyFiltered.rows;
  const groups = groupBySubject(sourceAllowedRows);
  const findings: ClaimContradictionFinding[] = [];
  for (const [clusterKey, group] of groups) {
    for (const finding of contradictionFindingsForGroup(clusterKey, group)) {
      findings.push(finding);
    }
  }
  const llmJudge = await runOptionalLlmJudge(input, sourceAllowedRows, policyFiltered, findings);
  const seenFindingKeys = new Set(findings.map(findingKey));
  for (const finding of llmJudge.findings) {
    if (findings.length >= input.maxFindings) break;
    const key = findingKey(finding);
    if (seenFindingKeys.has(key)) continue;
    seenFindingKeys.add(key);
    findings.push(finding);
  }
  const truncated = findings.length > input.maxFindings;
  const capped = findings.slice(0, input.maxFindings);

  return {
    findings: capped,
    counts: countsFor(capped),
    candidates_examined: sourceAllowedRows.length,
    scanned: sourceAllowedRows.length,
    truncated,
    access_safety: {
      only_visible_claims: true,
      raw_private_content_included: false,
      hidden_claim_counts_included: false,
      deterministic_judge: true,
      source_policy_enforced: true,
      llm_judge_requested: input.llmJudgeEnabled === true,
      llm_judge_used: llmJudge.used,
    },
    llm_judge: llmJudge.summary,
  };
}

// --- visibility-gated loads --------------------------------------------------

async function loadVisibleClaim(
  db: Queryable,
  spaceId: string,
  userId: string,
  claimId: string,
): Promise<ClaimRow | null> {
  const result = await db.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS}
       FROM ${CLAIM_FROM}
      WHERE c.space_id = $1
        AND c.object_id = $3
        AND so.deleted_at IS NULL
        AND ${readableClaimClause("$2")}
      LIMIT 1`,
    [spaceId, userId, claimId],
  );
  return result.rows[0] ?? null;
}

async function loadVisibleClaimsBySubjectObject(
  db: Queryable,
  spaceId: string,
  userId: string,
  subjectObjectId: string,
  limit: number,
): Promise<ClaimRow[]> {
  const result = await db.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS}
       FROM ${CLAIM_FROM}
      WHERE c.space_id = $1
        AND c.subject_object_id = $3
        AND so.deleted_at IS NULL
        AND c.status <> 'rejected'
        AND ${readableClaimClause("$2")}
      ORDER BY so.created_at ASC, c.object_id ASC
      LIMIT $4`,
    [spaceId, userId, subjectObjectId, limit],
  );
  return result.rows;
}

async function loadVisibleClaimsBySubjectText(
  db: Queryable,
  spaceId: string,
  userId: string,
  subjectText: string | null,
  limit: number,
): Promise<ClaimRow[]> {
  if (!subjectText) return [];
  const result = await db.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS}
       FROM ${CLAIM_FROM}
      WHERE c.space_id = $1
        AND c.subject_object_id IS NULL
        AND lower(btrim(c.subject_text)) = lower(btrim($3))
        AND so.deleted_at IS NULL
        AND c.status <> 'rejected'
        AND ${readableClaimClause("$2")}
      ORDER BY so.created_at ASC, c.object_id ASC
      LIMIT $4`,
    [spaceId, userId, subjectText, limit],
  );
  return result.rows;
}

async function loadVisibleActiveClaims(
  db: Queryable,
  spaceId: string,
  userId: string,
  subjectObjectId: string | null,
  limit: number,
): Promise<ClaimRow[]> {
  const result = await db.query<ClaimRow>(
    `SELECT ${CLAIM_COLUMNS}
       FROM ${CLAIM_FROM}
      WHERE c.space_id = $1
        AND c.status = 'active'
        AND so.deleted_at IS NULL
        AND ($4::varchar IS NULL OR c.subject_object_id = $4)
        AND ${readableClaimClause("$2")}
      ORDER BY so.updated_at DESC, c.object_id DESC
      LIMIT $3`,
    [spaceId, userId, limit, subjectObjectId],
  );
  return result.rows;
}

async function loadVisibleHolderLabels(
  db: Queryable,
  spaceId: string,
  userId: string,
  holderObjectIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = uniqueStrings(holderObjectIds);
  if (ids.length === 0) return new Map();
  const result = await db.query<{ id: string; title: string | null }>(
    `SELECT so.id, so.title
       FROM space_objects so
      WHERE so.space_id = $1
        AND so.id = ANY($3::varchar[])
        AND so.deleted_at IS NULL
        AND ${readableSpaceObjectClause("so", "$2")}`,
    [spaceId, userId, ids],
  );
  const out = new Map<string, string>();
  for (const row of result.rows) {
    const title = row.title?.trim();
    if (title) out.set(row.id, title);
  }
  return out;
}

async function filterClaimsBySourcePolicy(
  db: Queryable,
  spaceId: string,
  userId: string,
  rows: readonly ClaimRow[],
): Promise<ClaimRow[]> {
  return (await filterClaimsBySourcePolicyWithSourceIds(db, spaceId, userId, rows)).rows;
}

interface SourcePolicyFilteredClaims {
  rows: ClaimRow[];
  sourceIdsByClaim: Map<string, string[]>;
  sourcePolicySnapshots: Record<string, unknown>;
}

async function filterClaimsBySourcePolicyWithSourceIds(
  db: Queryable,
  spaceId: string,
  userId: string,
  rows: readonly ClaimRow[],
): Promise<SourcePolicyFilteredClaims> {
  const sourceIdsByClaim = await loadClaimSourceConnectionIds(
    db,
    spaceId,
    rows.map((row) => row.id),
  );
  const allSourceIds = uniqueStrings([...sourceIdsByClaim.values()].flat());
  if (allSourceIds.length === 0) {
    return { rows: [...rows], sourceIdsByClaim, sourcePolicySnapshots: {} };
  }
  const [snapshots, viewerSpaceRole] = await Promise.all([
    loadSourcePolicySnapshots(db, spaceId, allSourceIds),
    loadViewerSpaceRole(db, spaceId, userId),
  ]);
  const sourcePolicySnapshots: Record<string, unknown> = {};
  for (const [id, snapshot] of snapshots.entries()) sourcePolicySnapshots[id] = snapshot;
  return {
    rows: rows.filter((row) =>
      (sourceIdsByClaim.get(row.id) ?? []).every((sourceId) => {
        const snapshot = snapshots.get(sourceId);
        return snapshot
          ? sourcePolicyAllowsRead(snapshot, {
              viewerUserId: userId,
              viewerSpaceRole,
            })
          : false;
      }),
    ),
    sourceIdsByClaim,
    sourcePolicySnapshots,
  };
}

async function loadClaimSourceConnectionIds(
  db: Queryable,
  spaceId: string,
  claimIds: readonly string[],
): Promise<Map<string, string[]>> {
  const ids = uniqueStrings(claimIds);
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  if (ids.length === 0) return out;
  const result = await db.query<{
    claim_id: string;
    source_connection_id: string | null;
    source_metadata_json: unknown;
  }>(
    `SELECT cs.claim_id, cs.source_connection_id, s.metadata_json AS source_metadata_json
       FROM claim_sources cs
       LEFT JOIN sources s
         ON s.object_id = cs.source_object_id
        AND s.space_id = cs.space_id
      WHERE cs.space_id = $1
        AND cs.claim_id = ANY($2::varchar[])`,
    [spaceId, ids],
  );
  for (const row of result.rows) {
    const current = out.get(row.claim_id) ?? [];
    for (const sourceId of uniqueStrings([
      row.source_connection_id,
      ...sourceConnectionIdsFromMetadata(row.source_metadata_json),
    ])) {
      if (!current.includes(sourceId)) current.push(sourceId);
    }
    out.set(row.claim_id, current);
  }
  return out;
}

// --- trajectory --------------------------------------------------------------

function trajectoryPoint(row: ClaimRow, holderObjectLabel: string | null | undefined): ClaimTrajectoryPoint {
  return {
    claim_id: row.id,
    title: row.title ?? row.claim_text.slice(0, 80),
    claim_kind: row.claim_kind,
    status: row.status,
    resolution_state: row.resolution_state,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    holder_label: holderObjectLabel ?? (row.holder_type ? row.holder_type : null),
    valid_from: isoOrNull(row.valid_from),
    valid_until: isoOrNull(row.valid_until),
    observed_at: isoOrNull(row.observed_at),
    created_at: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
  };
}

function uniqueStrings(values: readonly (string | null)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function trajectoryKey(point: ClaimTrajectoryPoint): number {
  const candidate = point.valid_from ?? point.observed_at ?? point.created_at;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? 0 : ms;
}

function trajectorySignals(points: readonly ClaimTrajectoryPoint[]): ClaimTrajectorySignal[] {
  const signals: ClaimTrajectorySignal[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    if (prev.status === "superseded" && cur.status === "active") {
      signals.push(signal("supersession", prev, cur, `Earlier assertion was superseded by "${cur.title}".`, "high"));
    } else if (prev.status !== cur.status) {
      signals.push(signal("status_change", prev, cur, `Status changed from ${prev.status} to ${cur.status}.`, "high"));
    }
    if (prev.resolution_state !== cur.resolution_state) {
      signals.push(
        signal(
          "resolution_change",
          prev,
          cur,
          `Resolution changed from ${prev.resolution_state} to ${cur.resolution_state}.`,
          "medium",
        ),
      );
    }
    if (
      typeof prev.confidence === "number" &&
      typeof cur.confidence === "number" &&
      Math.abs(cur.confidence - prev.confidence) >= 0.25
    ) {
      const direction = cur.confidence > prev.confidence ? "rose" : "fell";
      signals.push(
        signal(
          "confidence_shift",
          prev,
          cur,
          `Confidence ${direction} from ${prev.confidence.toFixed(2)} to ${cur.confidence.toFixed(2)}.`,
          "medium",
        ),
      );
    }
    if (prev.claim_kind !== cur.claim_kind) {
      signals.push(
        signal("kind_divergence", prev, cur, `Claim kind changed from ${prev.claim_kind} to ${cur.claim_kind}.`, "low"),
      );
    }
  }
  return signals;
}

function signal(
  kind: ClaimTrajectorySignal["kind"],
  from: ClaimTrajectoryPoint,
  to: ClaimTrajectoryPoint,
  summary: string,
  confidenceTier: ConfidenceTier,
): ClaimTrajectorySignal {
  return { kind, from_claim_id: from.claim_id, to_claim_id: to.claim_id, summary, confidence_tier: confidenceTier };
}

// --- contradiction discovery -------------------------------------------------

function groupBySubject(rows: readonly ClaimRow[]): Map<string, ClaimRow[]> {
  const groups = new Map<string, ClaimRow[]>();
  for (const row of rows) {
    const key = subjectKey(row);
    if (!key) continue;
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  }
  return groups;
}

function subjectKey(row: ClaimRow): string | null {
  if (row.subject_object_id) return `obj:${row.subject_object_id}`;
  const text = normalize(row.subject_text);
  return text ? `text:${text}` : null;
}

function contradictionFindingsForGroup(clusterKey: string, group: readonly ClaimRow[]): ClaimContradictionFinding[] {
  const findings: ClaimContradictionFinding[] = [];
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const detected = detectContradiction(group[i]!, group[j]!);
      if (!detected) continue;
      findings.push(buildFinding(clusterKey, group[i]!, group[j]!, detected));
    }
  }
  return findings;
}

interface DetectedContradiction {
  signal: ClaimContradictionSignal;
  tier: ConfidenceTier;
  reason: string;
}

function detectContradiction(a: ClaimRow, b: ClaimRow): DetectedContradiction | null {
  const aText = normalize(a.claim_text);
  const bText = normalize(b.claim_text);
  if (!aText || !bText || aText === bText) return null;

  const aNeg = hasNegation(a.claim_text);
  const bNeg = hasNegation(b.claim_text);
  const overlap = jaccard(coreTokens(a.claim_text), coreTokens(b.claim_text));

  if (aNeg !== bNeg && overlap >= 0.5) {
    const tier: ConfidenceTier = overlap >= 0.7 ? "high" : "medium";
    return {
      signal: "negation",
      tier,
      reason: `Two visible active claims about the same subject share ${(overlap * 100).toFixed(0)}% of their core terms but one negates the other.`,
    };
  }

  const aNum = firstNumber(a.claim_text);
  const bNum = firstNumber(b.claim_text);
  if (aNum !== null && bNum !== null && aNum !== bNum) {
    const overlapNoNum = jaccard(coreTokens(a.claim_text, true), coreTokens(b.claim_text, true));
    if (overlapNoNum >= 0.6) {
      return {
        signal: "numeric_opposition",
        tier: "medium",
        reason: `Two visible active claims about the same subject assert different values (${aNum} vs ${bNum}) for an otherwise matching statement.`,
      };
    }
  }

  return null;
}

function buildFinding(
  clusterKey: string,
  a: ClaimRow,
  b: ClaimRow,
  detected: DetectedContradiction,
): ClaimContradictionFinding {
  return {
    cluster_key: clusterKey,
    signal: detected.signal,
    confidence_tier: detected.tier,
    from_claim: { claim_id: a.id, title: a.title ?? a.claim_text.slice(0, 80) },
    to_claim: { claim_id: b.id, title: b.title ?? b.claim_text.slice(0, 80) },
    reason: detected.reason,
    proposed_action: {
      proposal_type: "object_relation_create",
      from_object_id: a.id,
      to_object_id: b.id,
      link_type: "contradicts",
      confidence: confidenceForTier(detected.tier),
    },
  };
}

function findingKey(finding: ClaimContradictionFinding): string {
  const action = finding.proposed_action;
  if (action) return `${action.from_object_id}->${action.to_object_id}:${action.link_type}`;
  return `${finding.from_claim.claim_id}->${finding.to_claim.claim_id}:${finding.signal}`;
}

function countsFor(findings: readonly ClaimContradictionFinding[]): Record<string, number> {
  const counts: Record<string, number> = { high: 0, medium: 0, low: 0, negation: 0, numeric_opposition: 0, llm_supported: 0 };
  for (const finding of findings) {
    counts[finding.confidence_tier] = (counts[finding.confidence_tier] ?? 0) + 1;
    counts[finding.signal] = (counts[finding.signal] ?? 0) + 1;
  }
  return counts;
}

async function runOptionalLlmJudge(
  input: ClaimContradictionScanInput,
  rows: readonly ClaimRow[],
  policyFiltered: SourcePolicyFilteredClaims,
  deterministicFindings: readonly ClaimContradictionFinding[],
): Promise<{
  findings: ClaimContradictionFinding[];
  used: boolean;
  summary: Record<string, unknown>;
}> {
  if (input.llmJudgeEnabled !== true) {
    return { findings: [], used: false, summary: { requested: false, used: false } };
  }
  if (!input.llmJudge) {
    return {
      findings: [],
      used: false,
      summary: { requested: true, used: false, skipped_reason: "llm_judge_provider_unavailable" },
    };
  }
  const maxFindings = Math.max(0, input.maxFindings - deterministicFindings.length);
  if (maxFindings === 0) {
    return {
      findings: [],
      used: false,
      summary: { requested: true, used: false, skipped_reason: "candidate_cap_reached" },
    };
  }
  const payloadSourceConnectionIds = uniqueStrings(
    rows.flatMap((row) => policyFiltered.sourceIdsByClaim.get(row.id) ?? []),
  );
  try {
    const findings = await input.llmJudge.judge({
      spaceId: input.spaceId,
      userId: input.userId,
      claims: rows.map((row) => ({
        claim_id: row.id,
        title: row.title ?? row.claim_text.slice(0, 80),
        claim_kind: row.claim_kind,
        claim_text: row.claim_text,
        subject_object_id: row.subject_object_id,
        subject_text: row.subject_text,
        confidence: typeof row.confidence === "number" ? row.confidence : null,
        source_connection_ids: policyFiltered.sourceIdsByClaim.get(row.id) ?? [],
      })),
      deterministicFindings,
      maxFindings,
      sourcePolicies: policyFiltered.sourcePolicySnapshots,
      payloadSourceConnectionIds,
    });
    const capped = findings.slice(0, maxFindings);
    return {
      findings: capped,
      used: capped.length > 0,
      summary: {
        requested: true,
        used: capped.length > 0,
        finding_count: capped.length,
        claim_count: rows.length,
        payload_source_connection_count: payloadSourceConnectionIds.length,
      },
    };
  } catch (error) {
    return {
      findings: [],
      used: false,
      summary: {
        requested: true,
        used: false,
        skipped_reason: "llm_judge_failed",
        error_class: error instanceof Error ? error.name : "unknown",
      },
    };
  }
}

function confidenceForTier(tier: ConfidenceTier): number {
  if (tier === "high") return 0.6;
  if (tier === "medium") return 0.45;
  return 0.3;
}

// --- text helpers ------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for",
  "and", "or", "that", "this", "it", "as", "at", "by", "with", "from", "has", "have", "had",
]);
const NEGATION = /\b(no|not|never|without|cannot|can't|won't|isn't|aren't|doesn't|don't|none|neither|nor|fails?|false)\b/;

function hasNegation(value: string): boolean {
  return NEGATION.test(` ${normalize(value)} `);
}

function coreTokens(value: string, dropNumbers = false): Set<string> {
  const tokens = normalize(value)
    .split(/[^a-z0-9.]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token) && !NEGATION.test(` ${token} `))
    .filter((token) => (dropNumbers ? !/^[0-9.]+$/.test(token) : true));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function firstNumber(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function normalize(value: string | null): string {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : value.toISOString();
  }
  if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}
