import type { Booking } from "./booking.js";

export type RootType = "assets" | "liabilities" | "equity" | "income" | "expenses";
export type DirectiveStatus = "draft" | "proposed" | "posted" | "voided";
export type DirectiveType =
  | "open"
  | "close"
  | "commodity"
  | "pad"
  | "balance"
  | "transaction"
  | "note"
  | "event"
  | "query"
  | "price"
  | "document"
  | "custom";
export type CommodityType = "currency" | "security" | "crypto" | "custom";
export type AccountVisibility = "space" | "private";
/** Which accounts a balance summary covers. */
export type BalanceScope = "all" | "shared" | "personal";

export interface FinanceBookRow {
  id: string;
  space_id: string;
  name: string;
  base_currency: string;
  operating_currency: string;
  status: string;
  created_by_user_id: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FinanceCommodityRow {
  id: string;
  book_id: string;
  space_id: string;
  symbol: string;
  commodity_type: CommodityType;
  name: string | null;
  precision: number | null;
  display_precision: number | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FinanceAccountRow {
  id: string;
  book_id: string;
  space_id: string;
  name: string;
  display_name: string | null;
  root_type: RootType;
  parent_account_id: string | null;
  commodity_constraints: string[] | null;
  opened_at: string;
  closed_at: string | null;
  booking_method: Booking | null;
  account_role: string | null;
  default_commodity: string | null;
  owner_user_id: string | null;
  visibility: AccountVisibility;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FinanceDirectiveRow {
  id: string;
  book_id: string;
  space_id: string;
  directive_type: DirectiveType;
  date: string;
  sequence: number;
  status: DirectiveStatus;
  source_activity_id: string | null;
  proposal_id: string | null;
  import_source_id: string | null;
  source_filename: string | null;
  source_lineno: number | null;
  source_hash: string | null;
  metadata_json: Record<string, unknown>;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface FinanceTransactionRow {
  directive_id: string;
  book_id: string;
  space_id: string;
  flag: string;
  payee: string | null;
  narration: string | null;
  external_id: string | null;
  import_hash: string | null;
  tags: string[];
  links: string[];
  metadata_json: Record<string, unknown>;
}

export interface FinancePostingRow {
  id: string;
  transaction_directive_id: string;
  book_id: string;
  space_id: string;
  account_id: string;
  account_name: string;
  amount_numeric: string | null;
  amount_text: string | null;
  amount_scale: number | null;
  commodity_id: string | null;
  commodity_symbol: string | null;
  cost_number_numeric: string | null;
  cost_number_text: string | null;
  cost_number_scale: number | null;
  cost_number_total_numeric: string | null;
  cost_number_total_text: string | null;
  cost_number_total_scale: number | null;
  cost_currency: string | null;
  cost_date: string | null;
  cost_label: string | null;
  cost_merge: boolean | null;
  price_number_numeric: string | null;
  price_number_text: string | null;
  price_number_scale: number | null;
  price_commodity_id: string | null;
  price_commodity_symbol: string | null;
  price_is_total: boolean;
  flag: string | null;
  sort_order: number;
  metadata_json: Record<string, unknown>;
}

export interface FinanceBalancePosition {
  accountId: string;
  accountName: string;
  positions: string[];
}

export interface FinanceValidationError {
  code: string;
  message: string;
  directiveId?: string;
  accountId?: string;
}
