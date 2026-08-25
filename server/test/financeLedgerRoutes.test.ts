import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime";

const {
  plugin: { financeLedgerPlugin },
  routes: { registerFinanceLedgerRoutes },
} = loadFinanceLedgerRuntime();

let container: TestPostgresDatabase | null = null;
let pool: Pool | null = null;
let app: FastifyInstance | null = null;

const SPACE_A = "space-finance-routes-a";
const SPACE_B = "space-finance-routes-b";
const USER_1 = "user-finance-routes-1";
const USER_2 = "user-finance-routes-2";

// Mutable guard state lets one Fastify instance simulate enablement, space,
// and member switches per test.
const guardState = {
  enabled: true,
  spaceId: SPACE_A,
  userId: USER_1,
};

beforeAll(async () => {
  container = await getTestPostgres(__filename, { empty: true });
  pool = new Pool({ connectionString: container.getConnectionUri() });
  for (const migration of financeLedgerPlugin.migrations!) {
    await pool.query(migration.sql);
  }

  app = Fastify();
  const fakeCtx = {
    pluginId: "finance_ledger",
    fastify: app,
    db: pool,
    config: {},
    isEnabled: async () => guardState.enabled,
    http: {
      resolveIdentity: async () => identity(),
      pluginGuard: async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!guardState.enabled) {
          reply.code(403).send({ detail: "plugin finance_ledger is disabled" });
          return null;
        }
        return identity();
      },
      sendError: (reply: FastifyReply, err: unknown) => {
        reply.code(500).send({ detail: err instanceof Error ? err.message : "error" });
      },
      parseJsonBody: (request: FastifyRequest) =>
        (request.body ?? {}) as Record<string, unknown>,
    },
    jobs: { register: () => {}, enqueue: async () => ({ jobId: "" }) },
    scheduler: { register: () => {} },
    proposals: { register: () => {} },
  };
  registerFinanceLedgerRoutes(app, pool, fakeCtx);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  guardState.enabled = true;
  guardState.spaceId = SPACE_A;
  guardState.userId = USER_1;
  await resetTables(pool!, ["finance_books"], { cascade: true });
});

function identity() {
  return { userId: guardState.userId, spaceId: guardState.spaceId };
}

async function createBookViaApi(): Promise<string> {
  const response = await app!.inject({
    method: "POST",
    url: "/api/v1/finance/books",
    payload: { name: "Household", base_currency: "USD" },
  });
  expect(response.statusCode).toBe(201);
  return response.json().book.id;
}

async function seedLedger(bookId: string): Promise<{ checkingId: string; foodId: string }> {
  await app!.inject({
    method: "POST",
    url: `/api/v1/finance/books/${bookId}/commodities`,
    payload: { symbol: "USD", commodity_type: "currency" },
  });
  const checking = await app!.inject({
    method: "POST",
    url: `/api/v1/finance/books/${bookId}/accounts`,
    payload: { name: "Assets:Bank:Checking", opened_at: "2026-01-01", currencies: ["USD"] },
  });
  const food = await app!.inject({
    method: "POST",
    url: `/api/v1/finance/books/${bookId}/accounts`,
    payload: { name: "Expenses:Food", opened_at: "2026-01-01" },
  });
  return { checkingId: checking.json().account.id, foodId: food.json().account.id };
}

describe("finance ledger routes", () => {
  it("fails closed when the plugin is disabled", async () => {
    guardState.enabled = false;
    const response = await app!.inject({ method: "GET", url: "/api/v1/finance/books" });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toContain("disabled");
  });

  it("creates and lists books scoped to the active space", async () => {
    await createBookViaApi();

    const listed = await app!.inject({ method: "GET", url: "/api/v1/finance/books" });
    expect(listed.json().books).toHaveLength(1);

    guardState.spaceId = SPACE_B;
    const otherSpace = await app!.inject({ method: "GET", url: "/api/v1/finance/books" });
    expect(otherSpace.json().books).toHaveLength(0);
  });

  it("hides books from other spaces behind 404", async () => {
    const bookId = await createBookViaApi();
    guardState.spaceId = SPACE_B;
    const response = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("manages options per book", async () => {
    const bookId = await createBookViaApi();
    const put = await app!.inject({
      method: "PUT",
      url: `/api/v1/finance/books/${bookId}/options/title`,
      payload: { value: "My Ledger" },
    });
    expect(put.statusCode).toBe(200);

    const options = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/options`,
    });
    expect(options.json().options).toEqual([
      expect.objectContaining({ name: "title", value_json: { value: "My Ledger" } }),
    ]);
  });

  it("creates accounts and commodities, closes accounts", async () => {
    const bookId = await createBookViaApi();
    const { checkingId } = await seedLedger(bookId);

    const accounts = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts`,
    });
    expect(accounts.json().accounts).toHaveLength(2);

    const commodities = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/commodities`,
    });
    expect(commodities.json().commodities).toEqual([
      expect.objectContaining({ symbol: "USD" }),
    ]);

    const close = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts/${checkingId}/close`,
      payload: { date: "2026-02-01" },
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().account.closed_at).toBe("2026-02-01");
  });

  it("creates, posts, and lists transactions with balances and ledger views", async () => {
    const bookId = await createBookViaApi();
    const { checkingId, foodId } = await seedLedger(bookId);

    const created = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/transactions`,
      payload: {
        date: "2026-07-02",
        payee: "Tesco",
        narration: "Groceries",
        post: true,
        postings: [
          { account_id: checkingId, amount: { number: "-12.50", commodity: "USD" } },
          { account_id: foodId, amount: { number: "12.50", commodity: "USD" } },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().directive.status).toBe("posted");

    const transactions = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/transactions`,
    });
    expect(transactions.json().transactions).toHaveLength(1);

    const directives = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/directives?status=posted&type=transaction`,
    });
    expect(directives.json().directives).toHaveLength(1);

    const balances = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/balances`,
    });
    expect(balances.json().balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountName: "Expenses:Food", positions: ["12.50 USD"] }),
      ]),
    );

    const ledger = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts/${checkingId}/ledger`,
    });
    expect(ledger.json().postings).toHaveLength(1);

    const validate = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/validate`,
    });
    expect(validate.json().errors).toEqual([]);
  });

  it("rejects unbalanced transactions with a structured 422", async () => {
    const bookId = await createBookViaApi();
    const { checkingId, foodId } = await seedLedger(bookId);

    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/transactions`,
      payload: {
        date: "2026-07-02",
        post: true,
        postings: [
          { account_id: checkingId, amount: { number: "-12.50", commodity: "USD" } },
          { account_id: foodId, amount: { number: "11.50", commodity: "USD" } },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain("does not balance");
  });

  it("composes account names from root_type, group, and leaf", async () => {
    const bookId = await createBookViaApi();
    const response = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: { root_type: "Assets", group: "Bank", leaf: "ICBC", opened_at: "2026-01-01" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().account.name).toBe("Assets:Bank:ICBC");
    expect(response.json().account.owner_user_id).toBeNull();
    expect(response.json().account.visibility).toBe("space");
    expect(response.json().account.default_commodity).toBeNull();

    const withDefault = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: {
        root_type: "Assets", group: "Bank", leaf: "CMB",
        opened_at: "2026-01-01", default_currency: "CNY", display_name: "招商银行",
      },
    });
    expect(withDefault.statusCode).toBe(201);
    expect(withDefault.json().account.default_commodity).toBe("CNY");
    expect(withDefault.json().account.display_name).toBe("招商银行");

    const conflicting = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: {
        root_type: "Assets", group: "Bank", leaf: "BOC",
        opened_at: "2026-01-01", currencies: ["USD"], default_currency: "CNY",
      },
    });
    expect(conflicting.statusCode).toBe(422);
    expect(conflicting.json().detail).toContain("allowed currencies");

    const invalid = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: { root_type: "Assets", group: "bank card", leaf: "ICBC", opened_at: "2026-01-01" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("hides private personal accounts from other members", async () => {
    const bookId = await createBookViaApi();
    const created = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: {
        root_type: "Assets",
        group: "Bank",
        leaf: "Secret",
        opened_at: "2026-01-01",
        owner: "personal",
        visible_to_space: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const accountId = created.json().account.id;
    expect(created.json().account.owner_user_id).toBe(USER_1);
    expect(created.json().account.visibility).toBe("private");

    const ownView = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts`,
    });
    expect(ownView.json().accounts).toHaveLength(1);

    guardState.userId = USER_2;
    const memberView = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts`,
    });
    expect(memberView.json().accounts).toHaveLength(0);

    const memberLedger = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/accounts/${accountId}/ledger`,
    });
    expect(memberLedger.statusCode).toBe(404);
  });

  it("lets only the owner toggle personal account visibility", async () => {
    const bookId = await createBookViaApi();
    const created = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: {
        root_type: "Assets",
        group: "Bank",
        leaf: "Mine",
        opened_at: "2026-01-01",
        owner: "personal",
      },
    });
    const accountId = created.json().account.id;

    guardState.userId = USER_2;
    const rejected = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts/${accountId}/visibility`,
      payload: { visibility: "private" },
    });
    expect(rejected.statusCode).toBe(403);

    guardState.userId = USER_1;
    const accepted = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts/${accountId}/visibility`,
      payload: { visibility: "private" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().account.visibility).toBe("private");
  });

  it("summarizes balances by shared, personal, and all scopes", async () => {
    const bookId = await createBookViaApi();
    await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/commodities`,
      payload: { symbol: "USD", commodity_type: "currency" },
    });
    const joint = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: { root_type: "Assets", group: "Bank", leaf: "Joint", opened_at: "2026-01-01" },
    });
    const mine = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: {
        root_type: "Assets", group: "Bank", leaf: "Mine",
        opened_at: "2026-01-01", owner: "personal",
      },
    });
    const equity = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/accounts`,
      payload: { root_type: "Equity", group: "Opening", leaf: "Balances", opened_at: "2026-01-01" },
    });

    const post = (accountId: string, amount: string) =>
      app!.inject({
        method: "POST",
        url: `/api/v1/finance/books/${bookId}/transactions`,
        payload: {
          date: "2026-07-01",
          post: true,
          postings: [
            { account_id: accountId, amount: { number: amount, commodity: "USD" } },
            { account_id: equity.json().account.id, amount: { number: `-${amount}`, commodity: "USD" } },
          ],
        },
      });
    await post(joint.json().account.id, "100.00");
    await post(mine.json().account.id, "40.00");

    const shared = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/balances?scope=shared`,
    });
    expect(shared.json().balances.map((b: { accountName: string }) => b.accountName).sort()).toEqual(
      ["Assets:Bank:Joint", "Equity:Opening:Balances"],
    );

    const personal = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/balances?scope=personal`,
    });
    expect(personal.json().balances).toEqual([
      expect.objectContaining({ accountName: "Assets:Bank:Mine", positions: ["40.00 USD"] }),
    ]);

    const all = await app!.inject({
      method: "GET",
      url: `/api/v1/finance/books/${bookId}/balances`,
    });
    expect(all.json().balances).toHaveLength(3);
  });

  it("imports and exports Beancount text", async () => {
    const bookId = await createBookViaApi();

    const imported = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/import/beancount`,
      payload: {
        text: [
          "2026-01-01 open Assets:Cash USD",
          "2026-01-01 open Expenses:Misc USD",
          '2026-01-02 * "Coffee"',
          "  Assets:Cash  -3.00 USD",
          "  Expenses:Misc  3.00 USD",
          "",
        ].join("\n"),
        filename: "coffee.beancount",
        post_directly: true,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().created_directives).toBe(3);
    expect(imported.json().errors).toEqual([]);

    const exported = await app!.inject({
      method: "POST",
      url: `/api/v1/finance/books/${bookId}/export/beancount`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().content).toContain('2026-01-02 * "Coffee"');
    expect(exported.json().export_id).toBeTruthy();
    expect(exported.json().content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
