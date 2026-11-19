import { PluginOperationRefusal } from "@rainver/protocol";
import { AccountNotFoundError, FinanceRuleError } from "./domain/errors.js";

/**
 * Turns a ledger refusal into a safe operation refusal: a short reason code
 * the page translates, never the message (a message may name an account,
 * echo file text or a database constraint). The ledger's own errors carry
 * prose; this is the one place that reads it. An unrecognised
 * `FinanceRuleError` is the generic `ledger_rule`; any other unrecognised
 * error (a bug, a host or database fault) stays an internal error.
 */
const RULES: ReadonlyArray<[RegExp, "invalid" | "conflict", string]> = [
  [/sequence, please retry/, "conflict", "busy_retry"],
  [/already imported by another member/, "conflict", "imported_by_another_member"],
  [/^Import (entry )?not found$|^Import entry no longer matches/, "invalid", "import_not_found"],
  [/^Directive not found$/, "invalid", "directive_not_found"],
  [/^Unknown account|Mapping for .*: account not found/, "invalid", "unknown_account"],
  [/^Unknown commodity/, "invalid", "unknown_commodity"],
  [/has posted entries after/, "invalid", "account_has_later_entries"],
  [/is before .* opened/, "invalid", "close_before_open"],
  [/already closed|^Account is closed/, "invalid", "account_closed"],
  [/not open yet|not open on/, "invalid", "account_not_open"],
  [/no stored text to retry/, "invalid", "import_text_unavailable"],
  [/not awaiting review/, "invalid", "entry_not_awaiting_review"],
  [/only an unfinished entry takes a mapping/, "invalid", "entry_not_mappable"],
  [/needs an account id|does not reference account/, "invalid", "mapping_invalid"],
  [/^Invalid account (name|root)/, "invalid", "invalid_account_name"],
  [/^Invalid commodity symbol/, "invalid", "invalid_commodity"],
  [/^Invalid (decimal|ISO date|booking method|cost)/, "invalid", "invalid_value"],
  [/Only personal accounts can be private/, "invalid", "private_requires_personal"],
  [/Default commodity must be one of/, "invalid", "default_currency_not_allowed"],
  [/voided directive/, "invalid", "directive_voided"],
  [/does not balance|incomplete posting|cost specification|at least two postings|Currency mismatch/, "invalid", "transaction_unbalanced"],
];

function pgCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function financeRefusal(error: unknown): unknown {
  if (error instanceof PluginOperationRefusal) return error;
  if (error instanceof AccountNotFoundError) return new PluginOperationRefusal("invalid", "account_not_found");
  const code = pgCode(error);
  if (code === "23505") return new PluginOperationRefusal("conflict", "already_exists");
  if (code === "23503" || code === "23514" || code === "22P02" || code === "22007" || code === "22008") return new PluginOperationRefusal("invalid", "constraint_refused");
  if (code) return error;
  // Only the ledger's own refusals: plain `Error`s it throws and `FinanceRuleError`, never a TypeError or the like.
  if (!(error instanceof Error) || (error.constructor !== Error && !(error instanceof FinanceRuleError))) return error;
  for (const [pattern, kind, reason] of RULES) if (pattern.test(error.message)) return new PluginOperationRefusal(kind, reason);
  return error instanceof FinanceRuleError ? new PluginOperationRefusal("invalid", "ledger_rule") : error;
}
