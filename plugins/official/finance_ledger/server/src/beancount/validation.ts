import { Amount } from "../domain/amount.js";
import { compareDecimal, multiplyDecimal, negateDecimal } from "../domain/decimal.js";
import { Cost, CostSpec } from "../domain/position.js";
import type {
  BalanceEntry,
  LedgerEntry,
  LedgerError,
  OpenEntry,
  PadEntry,
  PostingEntry,
  TransactionEntry,
} from "./entries.js";
import { isDatedEntry } from "./entries.js";
import { sortEntries } from "./sort.js";

export function transformEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return applyPadDirectives(interpolateEntries(entries));
}

export function interpolateEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "transaction") return entry;
    return interpolateTransaction(entry);
  });
}

export function validateEntries(entries: readonly LedgerEntry[]): LedgerError[] {
  const sorted = sortEntries(entries);
  const errors: LedgerError[] = [];
  const openAccounts = new Map<string, OpenEntry>();
  const closedAccounts = new Set<string>();
  const activeAccounts = new Set<string>();
  const commodities = new Set<string>();
  const balances = new Map<string, BalanceEntry>();
  const runningBalances = new Map<string, Amount>();

  for (const entry of sorted) {
    if (!isDatedEntry(entry)) continue;

    if (entry.type === "open") {
      if (openAccounts.has(entry.account)) {
        errors.push(error("duplicate_open", `Duplicate open directive for ${entry.account}`, entry));
      } else {
        openAccounts.set(entry.account, entry);
        activeAccounts.add(entry.account);
      }
      continue;
    }

    if (entry.type === "close") {
      const opened = openAccounts.get(entry.account);
      if (!opened) {
        errors.push(error("close_unopened", `Unopened account ${entry.account} is being closed`, entry));
      } else if (entry.date < opened.date) {
        errors.push(error("close_before_open", `Close before open for ${entry.account}`, entry));
      }
      if (closedAccounts.has(entry.account)) {
        errors.push(error("duplicate_close", `Duplicate close directive for ${entry.account}`, entry));
      }
      closedAccounts.add(entry.account);
      activeAccounts.delete(entry.account);
      continue;
    }

    if (entry.type === "commodity") {
      if (commodities.has(entry.currency)) {
        errors.push(error("duplicate_commodity", `Duplicate commodity directive for ${entry.currency}`, entry));
      }
      commodities.add(entry.currency);
    }

    for (const account of referencedAccounts(entry)) {
      if (!activeAccounts.has(account)) {
        const code = openAccounts.has(account) ? "inactive_account" : "unknown_account";
        errors.push(error(code, `Invalid reference to ${code === "inactive_account" ? "inactive" : "unknown"} account ${account}`, entry));
      }
    }

    if (entry.type === "transaction") {
      errors.push(...validateTransaction(entry, openAccounts));
      applyTransactionToBalances(runningBalances, entry);
    }

    if (entry.type === "document" && entry.filename.trim() === "") {
      errors.push(error("invalid_document_path", `Document directive for ${entry.account} has an empty path`, entry));
    }

    if (entry.type === "balance") {
      const key = `${entry.account}|${entry.amount.currency}|${entry.date}`;
      const previous = balances.get(key);
      if (previous && !previous.amount.equals(entry.amount)) {
        errors.push(error("duplicate_balance", "Duplicate balance assertion with different amounts", entry));
      }
      balances.set(key, entry);
      const actual = subtreeBalance(runningBalances, entry.account, entry.amount.currency);
      const diff = actual.add(entry.amount.negate());
      if (!diffWithinTolerance(diff, entry.tolerance ?? inferredBalanceTolerance(entry.amount))) {
        errors.push(
          error(
            "balance_assertion_failed",
            `Balance assertion failed for ${entry.account}: expected ${entry.amount.toString()}, actual ${actual.toString()}`,
            entry,
          ),
        );
      }
    }
  }

  return errors;
}

function applyPadDirectives(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const sorted = sortEntries(entries);
  const result: LedgerEntry[] = [];
  const runningBalances = new Map<string, Amount>();
  const pendingPads = new Map<string, PadEntry>();

  for (const entry of sorted) {
    if (!isDatedEntry(entry)) {
      result.push(entry);
      continue;
    }

    if (entry.type === "pad") {
      pendingPads.set(entry.account, entry);
      result.push(entry);
      continue;
    }

    if (entry.type === "balance") {
      const actual = subtreeBalance(runningBalances, entry.account, entry.amount.currency);
      const diff = entry.amount.add(actual.negate());
      const pad = pendingPads.get(entry.account);
      if (pad && !diff.isZero()) {
        // Beancount inserts the padding transaction at the pad directive's
        // own date, flagged 'P' (ops/pad.py).
        const synthetic = {
          type: "transaction" as const,
          date: pad.date,
          flag: "P",
          payee: null,
          narration: `Pad ${entry.account}`,
          tags: new Set<string>(),
          links: new Set<string>(),
          postings: [
            {
              account: entry.account,
              units: diff,
              cost: null,
              price: null,
              priceIsTotal: false,
              flag: null,
              meta: {},
            },
            {
              account: pad.sourceAccount,
              units: diff.negate(),
              cost: null,
              price: null,
              priceIsTotal: false,
              flag: null,
              meta: {},
            },
          ],
          meta: { generated_by: "finance_ledger_pad" },
          source: pad.source,
        };
        result.push(synthetic);
        applyTransactionToBalances(runningBalances, synthetic);
        pendingPads.delete(entry.account);
      }
      result.push(entry);
      continue;
    }

    if (entry.type === "transaction") applyTransactionToBalances(runningBalances, entry);
    result.push(entry);
  }

  return sortEntries(result);
}

function interpolateTransaction(entry: TransactionEntry): TransactionEntry {
  const missing = entry.postings.filter((posting) => posting.units === null);
  if (missing.length !== 1) return entry;
  const target = missing[0]!;
  if (target.cost || target.price) return entry;

  const weights: Amount[] = [];
  for (const posting of entry.postings) {
    if (posting === target) continue;
    const weight = posting.units ? postingWeight(posting) : null;
    if (!weight) return entry;
    weights.push(weight.amount);
  }
  const currency = weights[0]?.currency;
  if (!currency || weights.some((weight) => weight.currency !== currency)) return entry;

  const residual = weights.reduce((sum, amount) => sum.add(amount), Amount.of("0", currency));
  const replacement = residual.negate();
  return {
    ...entry,
    postings: entry.postings.map((posting) =>
      posting === target ? { ...posting, units: replacement, meta: { ...posting.meta, interpolated: true } } : posting,
    ),
  };
}

function validateTransaction(
  entry: TransactionEntry,
  openAccounts: Map<string, OpenEntry>,
): LedgerError[] {
  if (entry.postings.length < 2) {
    return [error("transaction_postings_min", "Transaction must have at least two postings", entry)];
  }

  if (!isValidFlag(entry.flag)) {
    return [error("invalid_flag", `Invalid transaction flag: ${entry.flag}`, entry)];
  }

  for (const posting of entry.postings) {
    if (posting.flag !== null && !isValidFlag(posting.flag)) {
      return [error("invalid_flag", `Invalid posting flag: ${posting.flag}`, entry)];
    }
    if (!posting.units) continue;
    const open = openAccounts.get(posting.account);
    if (open && open.currencies.length > 0 && !open.currencies.includes(posting.units.currency)) {
      return [
        error(
          "currency_constraint",
          `Invalid currency ${posting.units.currency} for account ${posting.account}`,
          entry,
        ),
      ];
    }
  }

  return transactionBalanceErrors(entry.postings).map((balanceError) => ({
    ...balanceError,
    source: entry.source,
  }));
}

/**
 * Weight-based balance check shared by the text engine and the DB-side
 * posting validation. Returns structured errors without source locations.
 */
export function transactionBalanceErrors(
  postings: readonly PostingEntry[],
): Array<{ code: string; message: string }> {
  const residuals = new Map<string, Amount>();
  const toleranceScales = new Map<string, number>();
  for (const posting of postings) {
    if (!posting.units) {
      return [
        { code: "transaction_incomplete", message: "Transaction contains an incomplete posting" },
      ];
    }
    const weight = postingWeight(posting);
    if (!weight) {
      return [
        {
          code: "unsupported_cost_spec",
          message: `Posting for ${posting.account} has a cost specification that cannot be weighed`,
        },
      ];
    }
    const current = residuals.get(weight.amount.currency);
    residuals.set(weight.amount.currency, current ? current.add(weight.amount) : weight.amount);
    // Integer amounts do not contribute to tolerance inference
    // (core/interpolate.py infer_tolerances).
    if (weight.toleranceScale > 0) {
      const knownScale = toleranceScales.get(weight.amount.currency);
      toleranceScales.set(
        weight.amount.currency,
        knownScale === undefined
          ? weight.toleranceScale
          : Math.min(knownScale, weight.toleranceScale),
      );
    }
  }

  return [...residuals.entries()]
    .filter(([currency, amount]) =>
      !diffWithinTolerance(amount, balancingTolerance(currency, toleranceScales.get(currency) ?? 0)),
    )
    .map(([, amount]) => ({
      code: "transaction_unbalanced",
      message: `Transaction does not balance for ${amount.currency}: ${amount.toString()}`,
    }));
}

// Beancount weight semantics (core/convert.get_weight): postings held at cost
// weigh in at cost value, postings with a price convert at that price, and
// plain postings weigh their own units.
function postingWeight(
  posting: PostingEntry,
): { amount: Amount; toleranceScale: number } | null {
  const units = posting.units!;
  if (posting.cost instanceof Cost) {
    return {
      amount: Amount.of(multiplyDecimal(units.number, posting.cost.number), posting.cost.currency),
      toleranceScale: posting.cost.number.scale,
    };
  }
  if (posting.cost instanceof CostSpec) {
    const spec = posting.cost;
    if (spec.currency && spec.numberPer) {
      return {
        amount: Amount.of(multiplyDecimal(units.number, spec.numberPer), spec.currency),
        toleranceScale: spec.numberPer.scale,
      };
    }
    if (spec.currency && spec.numberTotal) {
      const negative = units.number.coefficient < 0n;
      return {
        amount: Amount.of(negative ? negateDecimal(spec.numberTotal) : spec.numberTotal, spec.currency),
        toleranceScale: spec.numberTotal.scale,
      };
    }
    return null;
  }
  if (posting.price) {
    if (posting.priceIsTotal) {
      const negative = units.number.coefficient < 0n;
      return {
        amount: Amount.of(
          negative ? negateDecimal(posting.price.number) : posting.price.number,
          posting.price.currency,
        ),
        toleranceScale: posting.price.number.scale,
      };
    }
    return {
      amount: Amount.of(
        multiplyDecimal(units.number, posting.price.number),
        posting.price.currency,
      ),
      toleranceScale: posting.price.number.scale,
    };
  }
  return { amount: units, toleranceScale: units.number.scale };
}

// Inferred balancing tolerance: half of the coarsest precision seen for the
// currency across the transaction's postings. Integer amounts balance exactly.
function balancingTolerance(currency: string, scale: number): Amount | null {
  if (scale <= 0) return null;
  return Amount.of(`0.${"0".repeat(scale)}5`, currency);
}

function applyTransactionToBalances(
  balances: Map<string, Amount>,
  entry: TransactionEntry,
): void {
  for (const posting of entry.postings) {
    if (!posting.units) continue;
    const key = balanceKey(posting.account, posting.units.currency);
    const current = balances.get(key);
    balances.set(key, current ? current.add(posting.units) : posting.units);
  }
}

function balanceKey(account: string, currency: string): string {
  return `${account}|${currency}`;
}

// Beancount balance assertions apply to the account plus its sub-accounts
// (ops/balance.py computes the realization subtree balance).
function subtreeBalance(
  runningBalances: Map<string, Amount>,
  account: string,
  currency: string,
): Amount {
  let total = Amount.of("0", currency);
  const prefix = `${account}:`;
  for (const [key, amount] of runningBalances) {
    const [balanceAccount, balanceCurrency] = key.split("|") as [string, string];
    if (balanceCurrency !== currency) continue;
    if (balanceAccount === account || balanceAccount.startsWith(prefix)) {
      total = total.add(amount);
    }
  }
  return total;
}

// Beancount's inferred balance-assertion tolerance is the tolerance
// multiplier (default 0.5) doubled, scaled to the asserted amount's last
// digit — i.e. one full unit of the final decimal place (ops/balance.py).
function inferredBalanceTolerance(amount: Amount): Amount | null {
  const scale = amount.number.scale;
  if (scale <= 0) return null;
  return Amount.of(`0.${"0".repeat(scale - 1)}1`, amount.currency);
}

function diffWithinTolerance(diff: Amount, tolerance: Amount | null): boolean {
  if (diff.isZero()) return true;
  if (!tolerance) return false;
  const absolute = diff.compare(Amount.of("0", diff.currency)) < 0 ? diff.negate() : diff;
  return compareDecimal(absolute.number, tolerance.number) <= 0;
}

// Beancount flag set (core/flags.py) plus 'P' for padding-generated entries.
const VALID_FLAGS = new Set(["*", "!", "&", "#", "?", "%", "P", "S", "T", "C", "U", "R", "M"]);

function isValidFlag(flag: string): boolean {
  return VALID_FLAGS.has(flag);
}

function referencedAccounts(entry: LedgerEntry): string[] {
  switch (entry.type) {
    case "transaction":
      return entry.postings.map((posting) => posting.account);
    case "balance":
    case "note":
    case "document":
      return [entry.account];
    case "pad":
      return [entry.account, entry.sourceAccount];
    default:
      return [];
  }
}

function error(code: string, message: string, entry: LedgerEntry): LedgerError {
  return { code, message, source: entry.source };
}
