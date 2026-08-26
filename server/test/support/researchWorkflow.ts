import type { Queryable } from "../../src/modules/routeUtils/common.js";
import { withQueryableTransaction } from "../../src/modules/routeUtils/common.js";
import { createResearchWorkflow } from "../../src/modules/projectResearch/workflowOntology.js";

/**
 * Real-Postgres fixture writer for the Workflow ontology aggregate. Tests use
 * the production writer so a fixture cannot silently omit root-object scope,
 * provenance, or its structural Inquiry relation.
 */
export async function insertResearchWorkflowFixture(
  db: Queryable,
  input: {
    id: string;
    spaceId: string;
    projectId: string;
    startedByUserId: string;
    status?: string;
    currentStage?: string | null;
    state?: unknown;
    primaryThreadId?: string | null;
    startedRunId?: string | null;
    title?: string;
    now?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();
  await withQueryableTransaction(db, (transaction) => createResearchWorkflow(transaction, {
    id: input.id,
    spaceId: input.spaceId,
    projectId: input.projectId,
    title: input.title ?? "Research workflow fixture",
    status: input.status ?? "active",
    currentStage: input.currentStage ?? null,
    state: input.state ?? {},
    startedByUserId: input.startedByUserId,
    startedRunId: input.startedRunId ?? null,
    primaryThreadId: input.primaryThreadId ?? null,
    now,
  }));
}
