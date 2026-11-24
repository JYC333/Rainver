import { readFileSync } from "node:fs";
import {
  PluginOperationRefusal,
  type PluginOperationContext,
  type PluginOperationExecutor,
  type PluginOperationId,
  type PluginProposalOptions,
  type Queryable,
  type RainverPlugin,
} from "@rainver/protocol";
import manifest, { POST_DIRECTIVE_PROPOSAL, POST_IMPORT_PROPOSAL, PLUGIN_ID, inputs, type FinanceOperation } from "../../operationManifest.js";
import type { FinanceBookRow } from "./domain/directives.js";
import type { FinanceImportSourceSummary } from "./domain/directiveRepository.js";
import type { FinanceImportEntryRow } from "./domain/importEntries.js";
import type { ImportBatchResult } from "./domain/importExportService.js";
import { financeLedgerService } from "./domain/service.js";
import { joinOperationTransaction, withLockedBook } from "./domain/transaction.js";
import { financeRefusal } from "./operationErrors.js";

/**
 * Server runtime of the Finance ledger package.
 *
 * Ownership (caller_owned, Space-level books): every ledger statement is the
 * existing ledger domain code, bound to the Space and person of the host
 * actor (`ctx.actor.space_id`, `on_behalf_of_user_id`, the same values as the
 * host GUCs), never to input. Books, shared accounts and their entries belong
 * to the Space; a personal `private` account, and every entry, balance,
 * ledger, validation result and export touching it, is read only by its owner;
 * an import batch only by the member who uploaded it.
 */
type In<K extends FinanceOperation> = (typeof inputs)[K]["_output"];
interface Call {
  db: Queryable;
  space: string;
  user: string;
}
const service = financeLedgerService;

async function requireBook({ db, space }: Call, bookId: string): Promise<FinanceBookRow> {
  const book = await service.findFinanceBook(db, space, bookId);
  if (!book) throw new PluginOperationRefusal("invalid", "book_not_found");
  return book;
}

function importSourceOut(source: FinanceImportSourceSummary) {
  return { id: source.id, source_type: source.source_type, source_name: source.source_name, content_hash: source.content_hash, created_at: source.created_at };
}
function importEntryOut(entry: FinanceImportEntryRow) {
  return {
    id: entry.id, entry_key: entry.entry_key, identity_kind: entry.identity_kind, external_id: entry.external_id, entry_type: entry.entry_type,
    entry_date: entry.entry_date, source_lineno: entry.source_lineno, raw_text: entry.raw_text, status: entry.status, status_reason: entry.status_reason,
    directive_id: entry.directive_id, duplicate_of_entry_id: entry.duplicate_of_entry_id, missing_accounts: entry.missing_accounts,
    missing_commodities: entry.missing_commodities, account_mapping: entry.account_mapping_json, mapping_version: entry.mapping_version, errors: entry.errors_json,
  };
}
/** Plain JSON rows: the ledger's DTOs as the legacy routes answered them. */
const rows = <T,>(value: readonly T[]) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>[];
const row = <T,>(value: T) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
function importBatchOut(result: ImportBatchResult) {
  return row({
    import_source: importSourceOut(result.importSource), batch_existed: result.batchExisted, created_directives: result.createdDirectives,
    summary: result.summary, entries: result.entries.map(importEntryOut), errors: result.errors,
  });
}

/** A full Beancount name, or the guided root + group + leaf (the schema checked the segments). */
function accountName(input: In<"account.open">): string {
  return input.name ?? `${input.root_type}:${input.group}:${input.leaf}`;
}

/** The entry as the requester can see it, for a posting decision. */
async function visibleDirective(call: Call, bookId: string, directiveId: string) {
  const all = await service.listDirectives(call.db, call.space, bookId, { viewerUserId: call.user });
  return all.find(directive => directive.id === directiveId) ?? null;
}
/** The requester's own import batch and its not yet posted entries, in a stable order. */
async function pendingImport(call: Call, bookId: string, importSourceId: string) {
  await service.getImportBatch(call.db, call.space, bookId, call.user, importSourceId);
  const isPending = (directive: { status: string }) => directive.status === "draft" || directive.status === "proposed";
  const pending = (await service.listDirectives(call.db, call.space, bookId, { importSourceId })).filter(isPending);
  const visible = (await service.listDirectives(call.db, call.space, bookId, { importSourceId, viewerUserId: call.user })).filter(isPending);
  if (pending.length !== visible.length) return null;
  return visible
    .map(directive => ({ id: directive.id, status: directive.status, updated_at: directive.updated_at }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const handlers: { [K in FinanceOperation]: (input: In<K>, call: Call) => Promise<unknown> } = {
  "book.list": async (_input, { db, space }) => ({ books: rows(await service.listFinanceBooks(db, space)) }),
  "book.create": async (input, { db, space, user }) => ({
    book: row(await service.createFinanceBook(db, space, user, { name: input.name, baseCurrency: input.base_currency, operatingCurrency: input.operating_currency })),
  }),
  "book.balances": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { balances: rows(await service.computeBalances(call.db, call.space, book.id, { viewerUserId: call.user, scope: input.scope ?? "all" })) };
  },
  "book.validate": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    const { errors } = await service.validateBook(call.db, call.space, book.id, call.user);
    // Codes only: a validation message names accounts and amounts.
    return { errors: errors.map(error => ({ code: error.code, directive_id: error.directiveId ?? null })) };
  },
  "option.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { options: rows(await service.listLedgerOptions(call.db, call.space, book.id)) };
  },
  "option.set": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    await service.createLedgerOption(call.db, call.space, book.id, { name: input.name, value: { value: input.value }, source: "manual" });
    return { name: input.name, value: input.value };
  },
  "account.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { accounts: rows(await service.listAccounts(call.db, call.space, book.id, call.user)) };
  },
  "account.open": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    const owner = input.owner ?? "shared";
    const visibleToSpace = input.visible_to_space !== false;
    if (owner === "shared" && !visibleToSpace) throw new PluginOperationRefusal("invalid", "shared_account_always_visible");
    try {
      return {
        account: row(await service.openAccount(call.db, call.space, book.id, {
          name: accountName(input), displayName: input.display_name ?? null, openedAt: input.opened_at,
          commodityConstraints: input.currencies?.length ? input.currencies : null, bookingMethod: input.booking_method ?? null,
          accountRole: input.account_role ?? null, defaultCommodity: input.default_currency || null,
          ownerUserId: owner === "personal" ? call.user : null, visibility: owner === "personal" && !visibleToSpace ? "private" : "space",
        })),
      };
    } catch (error) {
      // The name is unique per book, hidden accounts included: one answer, naming nothing.
      if ((error as { code?: string }).code === "23505") throw new PluginOperationRefusal("conflict", "account_exists");
      throw error;
    }
  },
  "account.set_visibility": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    try {
      return { account: row(await service.setAccountVisibility(call.db, call.space, book.id, input.account_id, call.user, input.visibility)) };
    } catch (error) {
      // One answer for every account this person may not change, as the legacy route gave.
      const refusal = financeRefusal(error);
      if (refusal instanceof PluginOperationRefusal && refusal.reason !== "private_requires_personal") throw new PluginOperationRefusal("invalid", "account_not_found");
      throw refusal;
    }
  },
  "account.close": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { account: row(await service.closeAccount(call.db, call.space, book.id, input.account_id, input.date, call.user)) };
  },
  "account.ledger": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { postings: rows(await service.getAccountLedger(call.db, call.space, book.id, input.account_id, call.user)) };
  },
  "commodity.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { commodities: rows(await service.listCommodities(call.db, call.space, book.id)) };
  },
  "commodity.create": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    try {
      return { commodity: row(await service.createCommodity(call.db, call.space, book.id, { symbol: input.symbol, commodityType: input.commodity_type ?? "custom", name: input.name ?? null })) };
    } catch (error) {
      // The book's own currency is registered with the book; adding it again is the ordinary conflict.
      if ((error as { code?: string }).code === "23505") throw new PluginOperationRefusal("conflict", "commodity_exists");
      throw error;
    }
  },
  "transaction.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return { transactions: rows(await service.listTransactions(call.db, call.space, book.id, call.user)) };
  },
  "transaction.create": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    // The book lock comes before the directive sequence, in the same order as an import.
    const directive = await withLockedBook(call.db, call.space, book.id, async tx => {
      const draft = await service.createTransactionDraft(tx, call.space, book.id, call.user, {
        date: input.date, flag: input.flag ?? "*", payee: input.payee ?? null, narration: input.narration ?? null,
        tags: input.tags ?? [], links: input.links ?? [],
        postings: input.postings.map(p => ({ accountId: p.account_id, amount: p.amount ? { number: p.amount.number, commoditySymbol: p.amount.commodity } : null, flag: p.flag ?? null })),
      });
      return input.post === true ? service.postDirective(tx, call.space, book.id, draft.id) : draft;
    });
    return { directive: row(directive) };
  },
  "directive.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return {
      directives: rows(await service.listDirectives(call.db, call.space, book.id, {
        status: input.status, directiveType: input.type, importSourceId: input.import_source_id, viewerUserId: call.user,
      })),
    };
  },
  /** Runs only as the canonical applier of an approved posting Proposal; posting revalidates under the book lock. */
  "directive.propose_post": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    const directive = await visibleDirective(call, book.id, input.directive_id);
    if (!directive) throw new PluginOperationRefusal("invalid", "directive_not_found");
    const posted = await service.postDirective(call.db, call.space, book.id, directive.id);
    return { directive_id: posted.id, status: posted.status };
  },
  "import.list": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    const { items, nextOffset } = await service.listImportBatches(call.db, call.space, book.id, call.user, input.offset);
    const imports = rows(items.map(({ importSource, summary }) => ({ ...importSourceOut(importSource), summary })));
    if (nextOffset === undefined) return { imports };
    return { imports, next_offset: nextOffset };
  },
  "import.get": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return importBatchOut(await service.getImportBatch(call.db, call.space, book.id, call.user, input.import_source_id));
  },
  "import.beancount": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return importBatchOut(await service.importBeancount(call.db, call.space, book.id, call.user, { text: input.text, sourceType: input.source_type }));
  },
  "import.retry": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return importBatchOut(await service.retryImportBatch(call.db, call.space, book.id, call.user, input.import_source_id));
  },
  "import.map_entry": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return importBatchOut(await service.applyImportEntryMapping(call.db, call.space, book.id, call.user, input.import_source_id, input.entry_id, input.account_mapping));
  },
  "import.review": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    return importBatchOut(await service.decideImportEntryReview(call.db, call.space, book.id, call.user, input.import_source_id, input.decision, input.entry_ids ?? null));
  },
  /** Runs only as the canonical applier of an approved posting Proposal: every entry of the batch revalidates, then all post together. */
  "import.propose_post": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    if (!(await pendingImport(call, book.id, input.import_source_id))?.length) throw new PluginOperationRefusal("conflict", "nothing_to_post");
    const { posted } = await service.postImportBatch(call.db, call.space, book.id, input.import_source_id, null);
    return { import_source_id: input.import_source_id, posted };
  },
  "export.beancount": async (input, call) => {
    const book = await requireBook(call, input.book_id);
    const result = await service.exportBeancount(call.db, call.space, book.id, call.user);
    return { export_id: result.export.id, content: result.content, content_hash: result.contentHash, errors: rows(result.errors) };
  },
};

function callOf(ctx: PluginOperationContext): Call {
  return { db: joinOperationTransaction(ctx.db), space: ctx.actor.space_id, user: ctx.actor.on_behalf_of_user_id! };
}
/** Parses with the declared schema, then runs the handler; ledger refusals leave as safe reason codes. */
const executor = (key: FinanceOperation): PluginOperationExecutor => async (raw, ctx) => {
  try {
    return await (handlers[key] as (input: unknown, call: Call) => Promise<unknown>)(inputs[key].parse(raw), callOf(ctx));
  } catch (error) {
    throw financeRefusal(error);
  }
};

/**
 * What a posting decision is about, frozen with the Proposal and re-read on
 * approval: any change to the entry (or to the batch's unposted entries)
 * supersedes the Proposal rather than posting something the person did not see.
 */
const directivePrecondition: NonNullable<PluginProposalOptions["preconditions"]> = async (raw, ctx, phase) => {
  try {
    const input = inputs["directive.propose_post"].parse(raw), call = callOf(ctx);
    await requireBook(call, input.book_id);
    const directive = await withLockedBook(call.db, call.space, input.book_id, db =>
      visibleDirective({ ...call, db }, input.book_id, input.directive_id));
    if (phase === "propose" && (!directive || directive.status === "posted" || directive.status === "voided")) throw new PluginOperationRefusal("invalid", "directive_not_postable");
    return { directive: directive ? { id: directive.id, status: directive.status, updated_at: directive.updated_at } : null };
  } catch (error) {
    throw financeRefusal(error);
  }
};
const importPrecondition: NonNullable<PluginProposalOptions["preconditions"]> = async (raw, ctx, phase) => {
  try {
    const input = inputs["import.propose_post"].parse(raw), call = callOf(ctx);
    await requireBook(call, input.book_id);
    const pending = await withLockedBook(call.db, call.space, input.book_id, db =>
      pendingImport({ ...call, db }, input.book_id, input.import_source_id));
    if (phase === "propose" && !pending?.length) throw new PluginOperationRefusal("conflict", "nothing_to_post");
    return { pending };
  } catch (error) {
    throw financeRefusal(error);
  }
};

export function createFinanceLedgerPlugin(): RainverPlugin {
  return {
    id: PLUGIN_ID,
    version: manifest.version,
    operationManifest: manifest,
    migrations: (manifest.migrations ?? []).map(id => ({ id, sql: readFileSync(new URL(`../../migrations/${id}.sql`, import.meta.url), "utf8") })),
    activate(ctx) {
      for (const key of Object.keys(handlers) as FinanceOperation[]) ctx.actions!.register(`plugin.${PLUGIN_ID}.${key}` as PluginOperationId, executor(key));
      ctx.lifecycle!.proposals.register(POST_DIRECTIVE_PROPOSAL, executor("directive.propose_post"), { preconditions: directivePrecondition });
      ctx.lifecycle!.proposals.register(POST_IMPORT_PROPOSAL, executor("import.propose_post"), { preconditions: importPrecondition });
      return { activated: true };
    },
  };
}

export const financeLedgerPlugin = createFinanceLedgerPlugin();
export default financeLedgerPlugin;
