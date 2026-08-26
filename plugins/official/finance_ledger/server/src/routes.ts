import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PluginHostContext,
  Queryable,
  ResolvedIdentity,
} from "@agent-space/protocol";
import type {
  BalanceScope,
  DirectiveStatus,
  DirectiveType,
  FinanceBookRow,
} from "./domain/directives.js";
import { financeLedgerService } from "./domain/service.js";

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
      );
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
      const commodity = await financeLedgerService.createCommodity(db, identity.spaceId, book.id, {
        symbol: requireString(body, "symbol"),
        commodityType:
          commodityType === "currency" || commodityType === "security" || commodityType === "crypto"
            ? commodityType
            : "custom",
        name: optionalString(body, "name"),
      });
      reply.code(201).send({ commodity });
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
        const directive = await financeLedgerService.createTransactionDraft(
          db,
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
        const posted =
          body["post"] === true
            ? await financeLedgerService.postDirective(db, identity.spaceId, book.id, directive.id)
            : directive;
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
        if (err instanceof Error && err.message === "Account not found") {
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
      const result = await financeLedgerService.validateBook(db, identity.spaceId, book.id);
      reply.send({ errors: result.errors });
    }),
  );

  app.post(
    "/api/v1/finance/books/:bookId/import/beancount",
    financeRoute(async (request, reply, identity) => {
      const book = await requireBook(request, identity);
      const body = ctx.http.parseJsonBody(request);
      try {
        const result = await financeLedgerService.importBeancount(
          db,
          identity.spaceId,
          book.id,
          identity.userId,
          {
            text: requireString(body, "text"),
            filename: optionalString(body, "filename") ?? undefined,
            sourceType: optionalString(body, "source_type") ?? undefined,
            status: body["post_directly"] === true ? "posted" : "proposed",
          },
        );
        reply.send({
          import_source_id: result.importSourceId,
          deduplicated: result.deduplicated,
          created_directives: result.createdDirectives,
          errors: result.errors,
        });
      } catch (err) {
        if (err instanceof RequestError) throw err;
        throw new RequestError(422, err instanceof Error ? err.message : "import failed");
      }
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
