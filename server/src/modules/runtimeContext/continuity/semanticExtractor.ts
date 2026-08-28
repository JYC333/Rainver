import type { ContextEvent, SemanticCheckpoint } from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { HttpError, type Queryable } from "../../routeUtils/common.js";
import { resolveProviderCommandStore } from "../../providers/commands/store.js";
import { completeProviderText } from "../../providers/invocation/invocation.js";
import type { SemanticCheckpointProviderPort } from "./service.js";
import type { RetrievalEgressPolicy } from "../../retrieval/egress/egressPolicy.js";
import {
  loadSourcePolicySnapshots,
  loadSourceConnectionIdsForTargets,
  sourceConnectionIdsFromMetadata,
  sourceConnectionIdsFromSourceRefs,
  sourceEgressPoliciesForSnapshots,
} from "../../retrieval/sourcePolicy.js";

const TASK = "context.checkpoint.extract";
/**
 * The one definition of what extracting a checkpoint means.
 *
 * Exported because imported CLI history is extracted with the same contract
 * (`modules/importedSessions/extraction.ts`) — a second prompt for the same
 * job would be a second, drifting definition of the output every consumer
 * downstream is written against.
 */
export const SEMANTIC_CHECKPOINT_SYSTEM_PROMPT = `You extract a complete Runtime Context semantic checkpoint.
Return only strict JSON with arrays: goals, user_intent, decisions, constraints,
facts, open_questions, tasks, artifact_refs, tool_refs, correction_refs.
Every semantic entry must cite one or more supplied canonical refs and must use
confirmation_state "candidate". Never invent refs. Tools and side effects are disabled.`;

export class ManagedSemanticCheckpointProvider implements SemanticCheckpointProviderPort {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  async extract(input: {
    spaceId: string;
    workContextScopeId: string;
    previous: SemanticCheckpoint | null;
    events: ContextEvent[];
    egressPolicy: RetrievalEgressPolicy;
  }) {
    const material = await Promise.all(input.events.map(async (event) => ({
      event,
      canonical_body: await resolveCanonicalBody(this.db, event),
    })));
    const metadataSourceIds = material.flatMap(({ canonical_body }) => {
      const body = recordValue(canonical_body);
      return [
        ...sourceConnectionIdsFromMetadata(body.metadata_json),
        ...sourceConnectionIdsFromSourceRefs(body.source_refs_json),
      ];
    });
    const provenanceRefs = [
      ...input.events.flatMap((event) => [event.canonical_ref, ...event.source_refs]),
      ...(input.previous?.source_refs.map((source) => source.ref) ?? []),
    ];
    const provenanceSourceIds = await sourceConnectionIdsForRefs(
      this.db,
      input.spaceId,
      provenanceRefs,
    );
    const sourceIds = [...new Set([...metadataSourceIds, ...provenanceSourceIds])];
    const sourcePolicies = sourceIds.length > 0
      ? sourceEgressPoliciesForSnapshots(await loadSourcePolicySnapshots(this.db, input.spaceId, sourceIds))
      : undefined;
    const completion = await completeProviderText(resolveProviderCommandStore(this.config), input.spaceId, {
      provider_id: "",
      model: null,
      system: SEMANTIC_CHECKPOINT_SYSTEM_PROMPT,
      user: JSON.stringify({
        previous_checkpoint: input.previous,
        selected_event_delta: material,
      }),
      max_tokens: 4_000,
      task: TASK,
      egressPolicy: {
        ...input.egressPolicy,
        ...(sourceIds.length > 0
          ? { payloadSourceConnectionIds: sourceIds, sourcePolicies }
          : {}),
      },
      metering: await checkpointMetering(this.db, input.spaceId, input.workContextScopeId),
    });
    return {
      extraction: parseJsonObject(completion.text),
      extractorRef: {
        type: "provider_task",
        id: `${TASK}:${input.workContextScopeId}:${input.events.at(-1)!.scope_sequence}`,
        version: `${completion.provider}/${completion.model}`,
      },
    };
  }
}

async function resolveCanonicalBody(db: Queryable, event: ContextEvent): Promise<unknown> {
  const ref = event.canonical_ref;
  if (ref.type === "message") {
    const result = await db.query(`SELECT role,content,metadata_json,created_at FROM messages WHERE id=$1 AND space_id=$2`, [ref.id, event.space_id]);
    return result.rows[0] ?? null;
  }
  if (ref.type === "run" || ref.type === "run_request") {
    const result = await db.query(
      ref.type === "run_request"
        ? `SELECT prompt,instruction,created_at FROM runs WHERE id=$1 AND space_id=$2`
        : `SELECT status,output_json,error_json,ended_at FROM runs WHERE id=$1 AND space_id=$2`,
      [ref.id, event.space_id],
    );
    return result.rows[0] ?? null;
  }
  if (ref.type === "artifact") {
    const result = await db.query(`SELECT title,content,artifact_type,metadata_json,updated_at FROM artifacts WHERE id=$1 AND space_id=$2`, [ref.id, event.space_id]);
    return result.rows[0] ?? null;
  }
  // Safe snapshots and run events contain canonical audit metadata but no raw
  // replay payload or credential material.
  if (ref.type === "invocation_snapshot") {
    const result = await db.query(`SELECT safe_snapshot_json FROM invocation_snapshots WHERE id=$1 AND space_id=$2`, [ref.id, event.space_id]);
    return result.rows[0]?.safe_snapshot_json ?? null;
  }
  if (ref.type === "run_event") {
    const result = await db.query(`SELECT event_type,status,summary,metadata_json,created_at FROM run_events WHERE id=$1 AND space_id=$2`, [ref.id, event.space_id]);
    return result.rows[0] ?? null;
  }
  if (ref.type === "checkpoint_correction") {
    const result = await db.query(
      `SELECT correction_json,canonical_ref_json,created_at
         FROM context_checkpoint_corrections
        WHERE id=$1 AND space_id=$2 AND work_context_scope_id=$3`,
      [ref.id, event.space_id, event.work_context_scope_id],
    );
    return result.rows[0] ?? null;
  }
  return null;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function sourceConnectionIdsForRefs(
  db: Queryable,
  spaceId: string,
  refs: readonly { type: string; id: string }[],
): Promise<string[]> {
  const direct = refs.filter((ref) => ref.type === "source_connection").map((ref) => ref.id);
  const grouped = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.type === "source_connection") continue;
    const ids = grouped.get(ref.type) ?? [];
    if (!ids.includes(ref.id)) ids.push(ref.id);
    grouped.set(ref.type, ids);
  }
  const linked = await Promise.all([...grouped.entries()].map(async ([type, ids]) => {
    const byTarget = await loadSourceConnectionIdsForTargets(db, spaceId, type, ids);
    return [...byTarget.values()].flat();
  }));
  return [...new Set([...direct, ...linked.flat()])];
}

/**
 * Who a checkpoint extraction is metered to.
 *
 * It used to name the work-context scope as a content resource
 * (`source_resource_type: "work_context_scope"`). No such resource exists —
 * a scope is not an ontology entity and has no table keyed by its id — so
 * attribution rejected every extraction with a 422 and the job failed. Because
 * attribution is resolved before the provider is called, no tokens were
 * spent; but from 2026-08-10 no semantic checkpoint was ever written, and
 * the "completed" jobs were the ones with too few events to extract.
 *
 * A scope belongs to the person whose work context it is: the owner of its
 * latest setup, with that setup's Project when it has one. That is the
 * "explicit owner, no source resource" attribution path, which is what a
 * background task on someone's behalf is.
 */
export async function checkpointMetering(
  db: Queryable,
  spaceId: string,
  workContextScopeId: string,
): Promise<{ subject_user_id: string; project_id: string | null }> {
  const setup = await db.query<{ user_id: string; project_id: string | null }>(
    `SELECT user_id, project_id FROM work_context_setups
      WHERE space_id = $1 AND work_context_scope_id = $2
      ORDER BY version DESC, created_at DESC
      LIMIT 1`,
    [spaceId, workContextScopeId],
  );
  const row = setup.rows[0];
  if (!row) {
    throw new HttpError(409, `Work context scope '${workContextScopeId}' has no setup to meter its checkpoint extraction to`);
  }
  return { subject_user_id: row.user_id, project_id: row.project_id ?? null };
}
