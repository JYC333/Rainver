import type {
  PluginHostContext,
  PluginProposalContext,
} from "@rainver/protocol";
import { financeLedgerService } from "./domain/service.js";

export const PROPOSAL_TYPE_POST_DIRECTIVE = "finance_ledger.post_directive";
export const PROPOSAL_TYPE_POST_IMPORT_BATCH = "finance_ledger.post_import_batch";

export function registerFinanceLedgerProposalAppliers(ctx: PluginHostContext): void {
  ctx.proposals.register(PROPOSAL_TYPE_POST_DIRECTIVE, applyPostDirective);
  ctx.proposals.register(PROPOSAL_TYPE_POST_IMPORT_BATCH, applyPostImportBatch);
}

/**
 * Posts a single draft/proposed directive. Validation re-runs at apply time
 * inside the service; a failed apply performs no writes.
 */
export async function applyPostDirective(ctx: PluginProposalContext): Promise<void> {
  const spaceId = requireSpaceId(ctx);
  const bookId = requirePayloadString(ctx, "book_id");
  const directiveId = requirePayloadString(ctx, "directive_id");
  await financeLedgerService.postDirective(ctx.db, spaceId, bookId, directiveId);
}

/**
 * Posts every pending directive from one import source. All transactions are
 * re-validated before any status changes; the update itself is a single bulk
 * statement, so a failure leaves no partially posted batch.
 */
export async function applyPostImportBatch(ctx: PluginProposalContext): Promise<void> {
  const spaceId = requireSpaceId(ctx);
  const bookId = requirePayloadString(ctx, "book_id");
  const importSourceId = requirePayloadString(ctx, "import_source_id");
  await financeLedgerService.postImportBatch(
    ctx.db,
    spaceId,
    bookId,
    importSourceId,
    ctx.proposal.id,
  );
}

function requireSpaceId(ctx: PluginProposalContext): string {
  if (!ctx.proposal.space_id) {
    throw new Error(`${ctx.proposal.proposal_type} requires a space-scoped proposal`);
  }
  return ctx.proposal.space_id;
}

function requirePayloadString(ctx: PluginProposalContext, key: string): string {
  const value = ctx.proposal.payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${ctx.proposal.proposal_type} payload requires ${key}`);
  }
  return value;
}
