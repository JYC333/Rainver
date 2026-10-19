import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PluginHostContext,
  Queryable,
  ResolvedIdentity,
} from "@rainver/protocol";
import type {
  BalanceScope,
  DirectiveStatus,
  DirectiveType,
  FinanceBookRow,
} from "./domain/directives.js";
import type { FinanceImportSourceRow } from "./domain/directiveRepository.js";
import type { FinanceImportEntryRow } from "./domain/importEntries.js";
import type { ImportBatchResult } from "./domain/importExportService.js";
import { AccountNotFoundError, FinanceRuleError, financeLedgerService } from "./domain/service.js";
import { withLockedBook } from "./domain/transaction.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIRECTIVE_STATUSES: readonly DirectiveStatus[] = ["draft", "proposed", "posted", "voided"];
const DIRECTIVE_TYPES: readonly DirectiveType[] = [
  "open", "close", "commodity", "pad", "balance", "transaction",
  "note", "event", "query", "price", "document", "custom",
];
const ACCOUNT_ROOTS = ["Assets", "Liabilities", "Equity", "Income", "Expenses"] as const;
const ACCOUNT_SEGMENT_RE = /^[A-Z0-9][A-Za-z0-9-]*$/;
const BALANCE_SCOPES: readonly BalanceScope[] = ["all", "shared", "personal"];

class RequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Postgres `unique_violation`. The driver surfaces it as `err.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RequestError(400, `${key} is required`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function requireDate(body: Record<string, unknown>, key: string): string {
  const value = requireString(body, key);
  if (!DATE_RE.test(value)) throw new RequestError(400, `${key} must be YYYY-MM-DD`);
  return value;
}

/** Strict request shape: a field this route does not take is a refusal, not a no-op. */
function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new RequestError(400, `unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }
}

/** A ledger-rule refusal about an import is 422; an unknown batch or entry is 404. */
function mapImportError(err: unknown): never {
  if (err instanceof RequestError) throw err;
  if (err instanceof FinanceRuleError) {
    throw new RequestError(/not found$/.test(err.message) ? 404 : 422, err.message);
  }
  throw err;
}

function importSourceOut(source: FinanceImportSourceRow) {
  return {
    id: source.id,
    source_type: source.source_type,
    source_name: source.source_name,
    content_hash: source.content_hash,
    created_at: source.created_at,
  };
}

function importEntryOut(entry: FinanceImportEntryRow) {
  return {
    id: entry.id,
    entry_key: entry.entry_key,
    identity_kind: entry.identity_kind,
    external_id: entry.external_id,
    entry_type: entry.entry_type,
    entry_date: entry.entry_date,
    source_lineno: entry.source_lineno,
    raw_text: entry.raw_text,
    status: entry.status,
    status_reason: entry.status_reason,
    directive_id: entry.directive_id,
    duplicate_of_entry_id: entry.duplicate_of_entry_id,
    missing_accounts: entry.missing_accounts,
    missing_commodities: entry.missing_commodities,
    account_mapping: entry.account_mapping_json,
    mapping_version: entry.mapping_version,
    errors: entry.errors_json,
  };
}

function importBatchOut(result: ImportBatchResult) {
  return {
    import_source: importSourceOut(result.importSource),
    batch_existed: result.batchExisted,
    created_directives: result.createdDirectives,
    summary: result.summary,
    entries: result.entries.map(importEntryOut),
    errors: result.errors,
  };
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (!value) throw new RequestError(400, `${name} is required`);
  return value;
}

export function registerFinanceLedgerRoutes(
  app: FastifyInstance,
  db: Queryable,
  ctx: PluginHostContext,
): void {
  // Wraps guard + book scoping + error mapping shared by every finance route.
  function financeRoute(
    handler: (
      request: FastifyRequest,
      reply: FastifyReply,
      identity: ResolvedIdentity,
    ) => Promise<void>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const identity = await ctx.http.pluginGuard(request, reply);
        if (!identity) return;
        await handler(request, reply, identity);
      } catch (err) {
        if (err instanceof RequestError) {
          reply.code(err.statusCode).send({ detail: err.message });
          return;
        }
        ctx.http.sendError(reply, err);
      }
    };
  }

  async function requireBook(
    request: FastifyRequest,
    identity: ResolvedIdentity,
  ): Promise<FinanceBookRow> {
    const bookId = param(request, "bookId");
    const book = await financeLedgerService.findFinanceBook(db, identity.spaceId, bookId);
    if (!book) throw new RequestError(404, "book not found");
    return book;
  }

  app.get(
    "/api/v1/finance/books",
    financeRoute(async (_request, reply, identity) => {
      const books = await financeLedgerService.listFinanceBooks(db, identity.spaceId);
      reply.send({ books });
    }),
  );

  app.post(
    "/api/v1/finance/books",
    financeRoute(async (request, reply, identity) => {
      const body = ctx.http.parseJsonBody(request);
      const book = await financeLedgerService.createFinanceBook(
        db,
        identity.spaceId,
        identity.userId,
        {
          name: requireString(body, "name"),
          baseCurrency: requireString(body, "base_currency"),
          operatingCurrency: optionalString(body, "operating_currency") ?? undefined,
        },
      );
      reply.code(201).send({ book });
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/options",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const options = await financeLedgerService.listLedgerOptions(db, identity.spaceId, book.id);
      reply.send({ options });
    }),
  );

  app.put(
    "/api/v1/finance/books/:bookId/options/:name",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const name = param(request, "name");
      const body = ctx.http.parseJsonBody(request);
      if (!("value" in body)) throw new RequestError(400, "value is required");
      await financeLedgerService.createLedgerOption(db, identity.spaceId, book.id, {
        name,
        value: { value: body["value"] },
        source: "manual",
      });
      reply.send({ name, value: body["value"] });
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/accounts",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const accounts = await financeLedgerService.listAccounts(
        db,
        identity.spaceId,
        book.id,
        identity.userId,
      );
      reply.send({ accounts });
    }),
  );

  // Accepts either a full Beancount `name` (advanced/import callers) or the
  // guided form: root_type + group + leaf, composed server-side so users never
  // write Beancount account syntax by hand.
  function composeAccountName(body: Record<string, unknown>): string {
    const explicitName = optionalString(body, "name");
    if (explicitName) return explicitName;
    const rootType = requireString(body, "root_type");
    if (!ACCOUNT_ROOTS.some((root) => root === rootType)) {
      throw new RequestError(400, `root_type must be one of ${ACCOUNT_ROOTS.join(", ")}`);
    }
    const group = requireString(body, "group");
    const leaf = requireString(body, "leaf");
    for (const segment of [group, leaf]) {
      if (!ACCOUNT_SEGMENT_RE.test(segment)) {
        throw new RequestError(
          400,
          "group and leaf must start with a capital letter or digit and contain only letters, digits, or dashes",
        );
      }
    }
    return `${rootType}:${group}:${leaf}`;
  }

  app.post(
    "/api/v1/finance/books/:bookId/accounts",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      const currencies = Array.isArray(body["currencies"])
        ? body["currencies"].filter((value): value is string => typeof value === "string")
        : null;
      const owner = optionalString(body, "owner") ?? "shared";
      if (owner !== "shared" && owner !== "personal") {
        throw new RequestError(400, "owner must be shared or personal");
      }
      const visibleToSpace = body["visible_to_space"] !== false;
      if (owner === "shared" && !visibleToSpace) {
        throw new RequestError(400, "shared accounts are always visible to the space");
      }
      try {
        const account = await financeLedgerService.openAccount(db, identity.spaceId, book.id, {
          name: composeAccountName(body),
          displayName: optionalString(body, "display_name"),
          openedAt: requireDate(body, "opened_at"),
          commodityConstraints: currencies && currencies.length > 0 ? currencies : null,
          bookingMethod: optionalString(body, "booking_method"),
          accountRole: optionalString(body, "account_role"),
          defaultCommodity: optionalString(body, "default_currency"),
          ownerUserId: owner === "personal" ? identity.userId : null,
          visibility: owner === "personal" && !visibleToSpace ? "private" : "space",
        });
        reply.code(201).send({ account });
      } catch (err) {
        if (err instanceof RequestError) throw err;
        // A unique violation on (book_id, name) says an account by that name
        // exists — including one hidden from this person, since the constraint
        // is book-wide and visibility is not part of it. Answer 409. Do not
        // echo the driver's message: it names the constraint and confirms the row.
        if (isUniqueViolation(err)) {
          throw new RequestError(409, "an account with that name already exists in this book");
        }
        throw new RequestError(422, err instanceof Error ? err.message : "invalid account");
      }
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/accounts/:accountId/visibility",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      const visibility = requireString(body, "visibility");
      if (visibility !== "space" && visibility !== "private") {
        throw new RequestError(400, "visibility must be space or private");
      }
      try {
        const account = await financeLedgerService.setAccountVisibility(
          db,
          identity.spaceId,
          book.id,
          param(request, "accountId"),
          identity.userId,
          visibility,
        );
        reply.send({ account });
      } catch (err) {
        // One answer for every account this person may not change. A 403 that
        // said *why* told a stranger the id exists and whether it is personal.
        if (err instanceof AccountNotFoundError) throw new RequestError(404, "Account not found");
        throw new RequestError(403, err instanceof Error ? err.message : "visibility change rejected");
      }
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/accounts/:accountId/close",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      const account = await financeLedgerService.closeAccount(
        db,
        identity.spaceId,
        book.id,
        param(request, "accountId"),
        requireDate(body, "date"),
        identity.userId,
      ).catch((err: unknown) => {
        // Only the "no such account for you" case becomes 404, and it is matched
        // by class: swallowing every error here reported a connection failure as
        // a missing account, and matching on the message meant rewording it
        // silently turned a deliberate 404 into a 500.
        if (err instanceof AccountNotFoundError) throw new RequestError(404, "Account not found");
        if (err instanceof FinanceRuleError) throw new RequestError(422, err.message);
        throw err;
      });
      reply.send({ account });
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/commodities",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const commodities = await financeLedgerService.listCommodities(db, identity.spaceId, book.id);
      reply.send({ commodities });
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/commodities",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      const commodityType = optionalString(body, "commodity_type");
      try {
        const commodity = await financeLedgerService.createCommodity(db, identity.spaceId, book.id, {
          symbol: requireString(body, "symbol"),
          commodityType:
            commodityType === "currency" || commodityType === "security" || commodityType === "crypto"
              ? commodityType
              : "custom",
          name: optionalString(body, "name"),
        });
        reply.code(201).send({ commodity });
      } catch (err) {
        if (err instanceof RequestError) throw err;
        // (book_id, symbol) is unique: the book's own currency is registered
        // when the book is made, so adding it again is the ordinary case.
        if (isUniqueViolation(err)) {
          throw new RequestError(409, "a commodity with that symbol already exists in this book");
        }
        throw new RequestError(422, err instanceof Error ? err.message : "invalid commodity");
      }
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/directives",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const query = request.query as Record<string, string>;
      const status = DIRECTIVE_STATUSES.find((candidate) => candidate === query["status"]);
      const directiveType = DIRECTIVE_TYPES.find((candidate) => candidate === query["type"]);
      const directives = await financeLedgerService.listDirectives(db, identity.spaceId, book.id, {
        status,
        directiveType,
        importSourceId: query["import_source_id"],
        viewerUserId: identity.userId,
      });
      reply.send({ directives });
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/transactions",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const transactions = await financeLedgerService.listTransactions(
        db,
        identity.spaceId,
        book.id,
        identity.userId,
      );
      reply.send({ transactions });
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/transactions",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      const postingsInput = body["postings"];
      if (!Array.isArray(postingsInput) || postingsInput.length === 0) {
        throw new RequestError(400, "postings is required");
      }
      const postings = postingsInput.map((posting: unknown) => {
        if (typeof posting !== "object" || posting === null) {
          throw new RequestError(400, "each posting must be an object");
        }
        const record = posting as Record<string, unknown>;
        const amount = record["amount"] as Record<string, unknown> | null | undefined;
        return {
          accountId: requireString(record, "account_id"),
          amount: amount
            ? {
                number: requireString(amount, "number"),
                commoditySymbol: requireString(amount, "commodity"),
              }
            : null,
          flag: optionalString(record, "flag"),
        };
      });

      try {
        // One transaction. A posting refused part way, or a post that does not
        // balance, must not leave a draft.
        // Lock before allocating a directive sequence. Waiting for the book
        // only at posting can deadlock an import on an uncommitted sequence.
        const posted = await withLockedBook(db, identity.spaceId, book.id, async (tx) => {
          const directive = await financeLedgerService.createTransactionDraft(
            tx,
            identity.spaceId,
            book.id,
            identity.userId,
            {
              date: requireDate(body, "date"),
              flag: optionalString(body, "flag") ?? "*",
              payee: optionalString(body, "payee"),
              narration: optionalString(body, "narration"),
              tags: Array.isArray(body["tags"]) ? body["tags"].filter((tag): tag is string => typeof tag === "string") : [],
              links: Array.isArray(body["links"]) ? body["links"].filter((link): link is string => typeof link === "string") : [],
              postings,
            },
          );
          return body["post"] === true
            ? financeLedgerService.postDirective(tx, identity.spaceId, book.id, directive.id)
            : directive;
        });
        reply.code(201).send({ directive: posted });
      } catch (err) {
        if (err instanceof RequestError) throw err;
        throw new RequestError(422, err instanceof Error ? err.message : "invalid transaction");
      }
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/accounts/:accountId/ledger",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      try {
        const postings = await financeLedgerService.getAccountLedger(
          db,
          identity.spaceId,
          book.id,
          param(request, "accountId"),
          identity.userId,
        );
        reply.send({ postings });
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          throw new RequestError(404, "account not found");
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/balances",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const query = request.query as Record<string, string>;
      const scope = BALANCE_SCOPES.find((candidate) => candidate === query["scope"]) ?? "all";
      const balances = await financeLedgerService.computeBalances(db, identity.spaceId, book.id, {
        viewerUserId: identity.userId,
        scope,
      });
      reply.send({ balances });
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/validate",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const result = await financeLedgerService.validateBook(db, identity.spaceId, book.id, identity.userId);
      reply.send({ errors: result.errors });
    }),
  );

  // An import only ever lands entries as `proposed`. The request carries the
  // file and nothing that could post it; a client that still sends a posting
  // switch is refused rather than quietly ignored.
  const IMPORT_FIELDS = ["text", "source_type"] as const;

  app.post(
    "/api/v1/finance/books/:bookId/import/beancount",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      rejectUnknownFields(body, IMPORT_FIELDS);
      const result = await financeLedgerService.importBeancount(
        db,
        identity.spaceId,
        book.id,
        identity.userId,
        {
          text: requireString(body, "text"),
          sourceType: optionalString(body, "source_type") ?? undefined,
        },
      ).catch(mapImportError);
      reply.send(importBatchOut(result));
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/imports",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const batches = await financeLedgerService.listImportBatches(db, identity.spaceId, book.id, identity.userId);
      reply.send({
        imports: batches.map(({ importSource, summary }) => ({ ...importSourceOut(importSource), summary })),
      });
    }),
  );

  app.get(
    "/api/v1/finance/books/:bookId/imports/:importSourceId",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const result = await financeLedgerService.getImportBatch(
        db, identity.spaceId, book.id, identity.userId, param(request, "importSourceId"),
      ).catch(mapImportError);
      reply.send(importBatchOut(result));
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/imports/:importSourceId/retry",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const result = await financeLedgerService.retryImportBatch(
        db, identity.spaceId, book.id, identity.userId, param(request, "importSourceId"),
      ).catch(mapImportError);
      reply.send(importBatchOut(result));
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/imports/:importSourceId/entries/:entryId/mapping",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      rejectUnknownFields(body, ["account_mapping"]);
      const mapping = body["account_mapping"];
      if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
        throw new RequestError(400, "account_mapping must be an object of account name to account id");
      }
      const accountMapping: Record<string, string> = {};
      for (const [name, accountId] of Object.entries(mapping as Record<string, unknown>)) {
        if (typeof accountId !== "string" || accountId.trim() === "") {
          throw new RequestError(400, `account_mapping for ${name} must be an account id`);
        }
        accountMapping[name] = accountId.trim();
      }
      const result = await financeLedgerService.applyImportEntryMapping(
        db, identity.spaceId, book.id, identity.userId,
        param(request, "importSourceId"), param(request, "entryId"), accountMapping,
      ).catch(mapImportError);
      reply.send(importBatchOut(result));
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/imports/:importSourceId/review",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      rejectUnknownFields(body, ["decision", "entry_ids"]);
      const decision = requireString(body, "decision");
      if (decision !== "import" && decision !== "duplicate") {
        throw new RequestError(400, "decision must be import or duplicate");
      }
      const rawIds = body["entry_ids"];
      let entryIds: string[] | null = null;
      if (rawIds !== undefined) {
        if (!Array.isArray(rawIds) || !rawIds.every((id): id is string => typeof id === "string" && id.trim() !== "")) {
          throw new RequestError(400, "entry_ids must be a list of entry ids");
        }
        entryIds = rawIds;
      }
      const result = await financeLedgerService.decideImportEntryReview(
        db, identity.spaceId, book.id, identity.userId, param(request, "importSourceId"), decision, entryIds,
      ).catch(mapImportError);
      reply.send(importBatchOut(result));
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/export/beancount",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const result = await financeLedgerService.exportBeancount(
        db,
        identity.spaceId,
        book.id,
        identity.userId,
      );
      reply.send({
        export_id: result.export.id,
        content: result.content,
        content_hash: result.contentHash,
        errors: result.errors,
      });
    }),
  );
}
