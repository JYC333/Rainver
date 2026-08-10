import type { ContextEvent, SemanticCheckpoint } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import type { Queryable } from "../../routeUtils/common";
import { resolveProviderCommandStore } from "../../providers/commands/store";
import { completeProviderText } from "../../providers/invocation/invocation";
import type { SemanticCheckpointProviderPort } from "./service";
import type { RetrievalEgressPolicy } from "../../retrieval/egress/egressPolicy";
import {
  loadSourcePolicySnapshots,
  loadSourceConnectionIdsForTargets,
  sourceConnectionIdsFromMetadata,
  sourceConnectionIdsFromSourceRefs,
  sourceEgressPoliciesForSnapshots,
} from "../../retrieval/sourcePolicy";

const TASK = "context.checkpoint.extract";
const SYSTEM = `You extract a complete Runtime Context semantic checkpoint.
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
      system: SYSTEM,
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
      metering: {
        source_resource_type: "work_context_scope",
        source_resource_id: input.workContextScopeId,
      },
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
