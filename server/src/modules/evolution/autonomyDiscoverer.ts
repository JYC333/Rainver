import { createHash, randomUUID } from "node:crypto";
import {
  autonomyDiscovererRegistry,
  type DiscoveredAutonomyCandidate,
} from "../autonomy/registry";

interface EvolutionSignalRow {
  id: string;
  target_id: string;
  signal_type: string;
  source_type: string;
  source_id: string | null;
  severity: string;
  summary: string | null;
  triage_status: string;
  created_at: string;
}

export function registerEvolutionReviewAutonomyDiscoverer(): void {
  autonomyDiscovererRegistry.register("evolution_review", {
    discover: async ({ db, spaceId, ownerUserId, config }) => {
      const active = await db.query(
        `SELECT 1
           FROM autonomy_candidates
          WHERE space_id = $1 AND owner_user_id = $2
            AND candidate_kind = 'evolution_review'
            AND status IN ('admitted', 'launched')
          LIMIT 1`,
        [spaceId, ownerUserId],
      );
      if (active.rows[0]) return [];

      const cursor = await db.query<{ last_fact_created_at: string; last_fact_id: string }>(
        `SELECT last_fact_created_at, last_fact_id
           FROM autonomy_review_cursors
          WHERE space_id = $1 AND owner_user_id = $2
            AND candidate_kind = 'evolution_review'
          LIMIT 1`,
        [spaceId, ownerUserId],
      );
      const limit = boundedInteger(config.evolution_review_max_signals, 100, 1, 250);
      const signals = await db.query<EvolutionSignalRow>(
        `SELECT es.id, es.target_id, es.signal_type, es.source_type, es.source_id,
                es.severity, es.summary, es.triage_status, es.created_at
           FROM evolution_signals es
           JOIN evolution_targets et
             ON et.id = es.target_id AND et.space_id = es.space_id
          WHERE es.space_id = $1
            AND es.triage_status IN ('new', 'acknowledged')
            AND et.status = 'active'
            AND et.enabled = true
            AND (
              $2::timestamptz IS NULL
              OR (es.created_at, es.id) > ($2::timestamptz, $3::varchar)
            )
          ORDER BY es.created_at ASC, es.id ASC
          LIMIT $4`,
        [
          spaceId,
          cursor.rows[0]?.last_fact_created_at ?? null,
          cursor.rows[0]?.last_fact_id ?? "",
          limit,
        ],
      );
      const rows = signals.rows;
      const minimum = boundedInteger(config.evolution_review_min_signals, 5, 1, 250);
      const urgent = rows.some((row) => row.severity === "error" || row.severity === "critical");
      if (!urgent && rows.length < minimum) return [];

      const first = rows[0]!;
      const last = rows.at(-1)!;
      const key = createHash("sha256")
        .update(rows.map((row) => row.id).join("\n"))
        .digest("hex");
      const severityCounts = countBy(rows.map((row) => row.severity));
      const typeCounts = countBy(rows.map((row) => row.signal_type));
      const candidate: DiscoveredAutonomyCandidate = {
        kind: "evolution_review",
        key,
        projectId: null,
        durableFactRefs: rows.map((row) => ({
          type: "evolution_signal",
          id: row.id,
          version: row.created_at,
        })),
        discoverySnapshot: {
          signal_ids: rows.map((row) => row.id),
          signal_count: rows.length,
          signal_window_start: { created_at: first.created_at, id: first.id },
          signal_window_end: { created_at: last.created_at, id: last.id },
          signals: rows.map((row) => ({
            id: row.id,
            target_id: row.target_id,
            signal_type: row.signal_type,
            source_type: row.source_type,
            source_id: row.source_id,
            severity: row.severity,
            summary: row.summary,
            triage_status: row.triage_status,
            created_at: row.created_at,
          })),
        },
        rankingScore: urgent ? 20_000 : 10_000 + rows.length,
        rankingEvidence: {
          algorithm: "severity_then_accumulated_signal_count",
          urgent,
          signal_count: rows.length,
          severity_counts: severityCounts,
          signal_type_counts: typeCounts,
          stable_tiebreak: key,
        },
        mayRequireInteractiveAuthorization: false,
      };
      return [candidate];
    },
    onMaterialized: async (db, candidateId, candidate, now) => {
      const signalIds = candidate.durableFactRefs
        .filter((ref) => ref.type === "evolution_signal")
        .map((ref) => ref.id);
      for (const signalId of signalIds) {
        await db.query(
          `INSERT INTO autonomy_candidate_evolution_signals (
             id, space_id, candidate_id, signal_id, linked_at
           )
           SELECT $1, ac.space_id, ac.id, es.id, $3
             FROM autonomy_candidates ac
             JOIN evolution_signals es
               ON es.id = $2 AND es.space_id = ac.space_id
            WHERE ac.id = $4
           ON CONFLICT (candidate_id, signal_id) DO NOTHING`,
          [randomUUID(), signalId, now.toISOString(), candidateId],
        );
      }
    },
    buildLaunch: ({ discoverySnapshot }) => {
      const signals = arrayRecords(discoverySnapshot.signals);
      const evidence = signals.map((signal) => [
        `- [${stringValue(signal.severity) ?? "unknown"}]`,
        stringValue(signal.signal_type) ?? "unknown_signal",
        `(${stringValue(signal.id) ?? "unknown"}):`,
        stringValue(signal.summary) ?? "No summary.",
      ].join(" ")).join("\n");
      return {
        capabilityId: "autonomy.evolution_review",
        capabilities: ["autonomy.evolution_review"],
        prompt: [
          "Create a private failure retrospective from these durable evolution signals:",
          evidence,
        ].join("\n\n"),
        instruction: [
          "Analyze only the supplied signal evidence and produce a concise Markdown report.",
          "Identify repeated failure patterns, likely causes, and reusable lessons.",
          "You may recommend a standard Proposal for later human review, but do not create or apply one.",
          "Never mutate a Capability, active Memory, proposal, evolution asset, or authoritative state.",
          "Do not request interactive authorization.",
        ].join(" "),
      };
    },
    buildReport: ({ now }) => ({
      artifactType: "autonomous_evolution_review",
      title: `Evolution Signal Review — ${now.toISOString().slice(0, 10)}`,
      fallbackContent: "The autonomous evolution review completed without a textual summary.",
    }),
    onCompleted: async (db, input) => {
      const last = await db.query<{ id: string; created_at: string }>(
        `SELECT es.id, es.created_at
           FROM autonomy_candidate_evolution_signals links
           JOIN evolution_signals es ON es.id = links.signal_id
          WHERE links.space_id = $1 AND links.candidate_id = $2
          ORDER BY es.created_at DESC, es.id DESC
          LIMIT 1`,
        [input.spaceId, input.candidateId],
      );
      const fact = last.rows[0];
      if (!fact) throw new Error(`Evolution review candidate '${input.candidateId}' has no linked signals`);
      await db.query(
        `UPDATE autonomy_candidate_evolution_signals
            SET consumed_at = COALESCE(consumed_at, $3)
          WHERE space_id = $1 AND candidate_id = $2`,
        [input.spaceId, input.candidateId, input.now.toISOString()],
      );
      await db.query(
        `INSERT INTO autonomy_review_cursors (
           id, space_id, owner_user_id, candidate_kind, candidate_id,
           last_fact_created_at, last_fact_id, created_at, updated_at
         ) VALUES ($1, $2, $3, 'evolution_review', $4, $5, $6, $7, $7)
         ON CONFLICT (space_id, owner_user_id, candidate_kind)
         DO UPDATE SET
           candidate_id = EXCLUDED.candidate_id,
           last_fact_created_at = EXCLUDED.last_fact_created_at,
           last_fact_id = EXCLUDED.last_fact_id,
           updated_at = EXCLUDED.updated_at
         WHERE (autonomy_review_cursors.last_fact_created_at, autonomy_review_cursors.last_fact_id)
             < (EXCLUDED.last_fact_created_at, EXCLUDED.last_fact_id)`,
        [
          randomUUID(),
          input.spaceId,
          input.ownerUserId,
          input.candidateId,
          fact.created_at,
          fact.id,
          input.now.toISOString(),
        ],
      );
    },
  }, "evolution");
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
