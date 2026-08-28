import type { ProjectWorkEventKind } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import {
  recordDomainWorkEvent,
  workEventBatchKey,
  type WorkEventProvenance,
} from "../projectWork/domainWorkEvents.js";

/**
 * Inquiry's advancements in the Project's readable account.
 *
 * The attribution, folding and undo-linkage rules live in
 * `projectWork/domainWorkEvents.ts` and are shared with every other domain
 * that writes directly; this fixes the subject to a Thread and nothing else.
 */
export type ThreadEventProvenance = WorkEventProvenance;

export function threadEventBatchKey(
  kind: ProjectWorkEventKind,
  provenance: ThreadEventProvenance | undefined,
): string | null {
  return workEventBatchKey(kind, provenance);
}

export async function recordThreadWorkEvent(
  db: Queryable,
  input: {
    spaceId: string;
    projectId: string;
    threadId: string;
    userId: string;
    eventKind: ProjectWorkEventKind;
    occurredAt: string;
    idempotencySuffix: string;
    data: Record<string, unknown>;
    provenance?: ThreadEventProvenance;
  },
): Promise<void> {
  const { threadId, ...rest } = input;
  await recordDomainWorkEvent(db, { ...rest, subjectType: "inquiry_thread", subjectId: threadId });
}
