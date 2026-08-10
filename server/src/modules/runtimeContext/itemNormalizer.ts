import { createHash } from "node:crypto";
import type {
  ContextItem,
  RuntimeContextAcquisition,
  RuntimeContextSelection,
  RuntimeContextSemanticRole,
  RuntimeContextSensitivity,
  RuntimeContextTrust,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { estimateModelTokens } from "../usage/modelCatalog";

export interface ContextItemSource {
  sourceRef: { type: string; id: string; version?: string | null };
  acquisition: RuntimeContextAcquisition;
  selection: RuntimeContextSelection;
  semanticRole: RuntimeContextSemanticRole;
  trust: RuntimeContextTrust;
  sensitivity: RuntimeContextSensitivity;
  visibility: ContextItem["visibility"];
  ownerUserId: string | null;
  spaceId: string;
  egressEligible: boolean;
  text: string;
  structuredPayload?: Record<string, unknown>;
  revalidation: Record<string, unknown> & { status: "live"; checked_at: string };
  conflictKey?: string | null;
  rank?: number | null;
  score?: number | null;
}

export function normalizeContextItem(source: ContextItemSource): ContextItem {
  const text = source.text.trim();
  const sourceKey = `${source.sourceRef.type}:${source.sourceRef.id}:${source.sourceRef.version ?? ""}`;
  return {
    id: createHash("sha256")
      .update(`${source.acquisition}\0${sourceKey}\0${source.semanticRole}\0${text}`)
      .digest("hex"),
    source_ref: source.sourceRef,
    acquisition: source.acquisition,
    selection: source.selection,
    rank: source.selection === "ranked" ? source.rank ?? 1 : null,
    score: source.score ?? null,
    semantic_role: source.semanticRole,
    trust: source.trust,
    sensitivity: source.sensitivity,
    visibility: source.visibility,
    owner_user_id: source.ownerUserId,
    space_id: source.spaceId,
    egress_eligible: source.egressEligible,
    token_estimate: estimateModelTokens(text),
    payload: { ...(source.structuredPayload ?? {}), text },
    revalidation: source.revalidation,
    conflict_key: source.conflictKey ?? null,
  };
}

export function contextItemText(item: ContextItem): string {
  const text = item.payload.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`Context item ${item.id} has no renderer-safe text payload`);
  }
  return text;
}
