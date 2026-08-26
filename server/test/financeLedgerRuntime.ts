import { createRequire } from "node:module";

export interface DecimalValueForTest {
  decimal: string;
  scale: number;
  coefficient: bigint;
}

export interface AmountForTest {
  add(other: AmountForTest): AmountForTest;
  negate(): AmountForTest;
  isZero(): boolean;
  compare(other: AmountForTest): number;
  equals(other: AmountForTest): boolean;
  toString(): string;
}

export interface CostForTest {
  toString(): string;
}

export interface PositionForTest {
  toString(): string;
}

export interface InventoryForTest {
  addPosition(position: PositionForTest): InventoryForTest;
  addAmount(amount: AmountForTest): InventoryForTest;
  positions(): PositionForTest[];
  balanceByCurrency(): Map<string, AmountForTest>;
  isEmpty(): boolean;
}

export interface FinanceLedgerRuntime {
  decimal: {
    parseDecimal(input: string): DecimalValueForTest;
    addDecimal(left: DecimalValueForTest, right: DecimalValueForTest): DecimalValueForTest;
    compareDecimal(left: DecimalValueForTest, right: DecimalValueForTest): number;
  };
  amount: {
    Amount: { of(number: string, currency: string): AmountForTest };
    isCommoditySymbol(value: string): boolean;
  };
  booking: {
    Booking: Record<string, string>;
    parseBooking(value: string | null | undefined): string | null;
  };
  position: {
    Cost: new (input: {
      number: string;
      currency: string;
      date?: string | null;
      label?: string | null;
    }) => CostForTest;
    CostSpec: new (input: {
      numberPer?: string | null;
      numberTotal?: string | null;
      currency?: string | null;
      merge?: boolean | null;
    }) => { toString(): string };
    Position: new (units: AmountForTest, cost?: CostForTest | null) => PositionForTest;
  };
  inventory: {
    Inventory: { empty(): InventoryForTest };
  };
  engine: {
    financeLedgerEngine: {
      loadFromText(text: string, filename?: string): { entries: Array<{ type: string }>; errors: LedgerErrorForTest[]; options: Record<string, string> };
      loadFromDb(db: unknown, spaceId: string, bookId: string): Promise<{ entries: Array<{ type: string }>; errors: LedgerErrorForTest[]; options: Record<string, string> }>;
      exportEntries(entries: readonly unknown[], options?: Record<string, string>): string;
    };
  };
  plugin: {
    financeLedgerPlugin: { migrations?: Array<{ id: string; sql: string }> };
  };
  service: {
    financeLedgerService: {
      createFinanceBook(db: unknown, spaceId: string, userId: string, input: Record<string, unknown>): Promise<Record<string, string>>;
      createCommodity(db: unknown, spaceId: string, bookId: string, input: Record<string, unknown>): Promise<Record<string, string>>;
      openAccount(db: unknown, spaceId: string, bookId: string, input: Record<string, unknown>): Promise<Record<string, string>>;
      listAccounts(db: unknown, spaceId: string, bookId: string, viewerUserId?: string): Promise<Array<Record<string, unknown>>>;
      setAccountVisibility(db: unknown, spaceId: string, bookId: string, accountId: string, userId: string, visibility: string): Promise<Record<string, unknown>>;
      getAccountLedger(db: unknown, spaceId: string, bookId: string, accountId: string, viewerUserId?: string): Promise<Array<Record<string, unknown>>>;
      listFinanceBooks(db: unknown, spaceId: string): Promise<Array<Record<string, string>>>;
      listDirectives(db: unknown, spaceId: string, bookId: string, filters?: Record<string, string>): Promise<Array<Record<string, unknown>>>;
      createTransactionDraft(db: unknown, spaceId: string, bookId: string, userId: string, input: Record<string, unknown>): Promise<Record<string, string>>;
      postDirective(db: unknown, spaceId: string, bookId: string, directiveId: string): Promise<Record<string, string>>;
      computeBalances(db: unknown, spaceId: string, bookId: string, options?: { viewerUserId?: string; scope?: string }): Promise<Array<Record<string, unknown>>>;
      closeAccount(db: unknown, spaceId: string, bookId: string, accountId: string, date: string): Promise<Record<string, string>>;
      importBeancount(db: unknown, spaceId: string, bookId: string, userId: string, input: Record<string, unknown>): Promise<ImportResultForTest>;
      exportBeancount(db: unknown, spaceId: string, bookId: string, userId: string): Promise<ExportResultForTest>;
      postImportBatch(db: unknown, spaceId: string, bookId: string, importSourceId: string, proposalId?: string | null): Promise<{ posted: number }>;
    };
    rootTypeForAccountName(accountName: string): string;
  };
  routes: {
    registerFinanceLedgerRoutes(app: unknown, db: unknown, ctx: unknown): void;
  };
  proposalAppliers: {
    PROPOSAL_TYPE_POST_DIRECTIVE: string;
    PROPOSAL_TYPE_POST_IMPORT_BATCH: string;
    applyPostDirective(ctx: ProposalContextForTest): Promise<void>;
    applyPostImportBatch(ctx: ProposalContextForTest): Promise<void>;
    registerFinanceLedgerProposalAppliers(ctx: unknown): void;
  };
}

export interface LedgerErrorForTest {
  code: string;
  message: string;
  source?: { filename: string; lineno: number };
}

export interface ImportResultForTest {
  importSourceId: string | null;
  deduplicated: boolean;
  createdDirectives: number;
  errors: LedgerErrorForTest[];
  options: Record<string, string>;
}

export interface ExportResultForTest {
  export: Record<string, unknown> & { id: string };
  content: string;
  contentHash: string;
  errors: LedgerErrorForTest[];
}

export interface ProposalContextForTest {
  proposal: {
    id: string;
    proposal_type: string;
    space_id: string | null;
    user_id: string | null;
    payload: Record<string, unknown>;
  };
  db: unknown;
  config: unknown;
}

export function loadFinanceLedgerRuntime(): FinanceLedgerRuntime {
  const requireRuntime = createRequire(import.meta.filename);
  return {
    decimal: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/decimal.js") as FinanceLedgerRuntime["decimal"],
    amount: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/amount.js") as FinanceLedgerRuntime["amount"],
    booking: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/booking.js") as FinanceLedgerRuntime["booking"],
    position: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/position.js") as FinanceLedgerRuntime["position"],
    inventory: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/inventory.js") as FinanceLedgerRuntime["inventory"],
    engine: requireRuntime("../dist/official-plugins/finance_ledger/server/beancount/engine.js") as FinanceLedgerRuntime["engine"],
    plugin: requireRuntime("../dist/official-plugins/finance_ledger/server/index.js") as FinanceLedgerRuntime["plugin"],
    service: requireRuntime("../dist/official-plugins/finance_ledger/server/domain/service.js") as FinanceLedgerRuntime["service"],
    routes: requireRuntime("../dist/official-plugins/finance_ledger/server/routes.js") as FinanceLedgerRuntime["routes"],
    proposalAppliers: requireRuntime("../dist/official-plugins/finance_ledger/server/proposalAppliers.js") as FinanceLedgerRuntime["proposalAppliers"],
  };
}
