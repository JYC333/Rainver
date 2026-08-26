import type { Booking } from "../domain/booking.js";
import type { Amount } from "../domain/amount.js";
import type { Cost, CostSpec } from "../domain/position.js";

export interface SourceLocation {
  filename: string;
  lineno: number;
}

export type MetadataValue = string | number | boolean | null;
export type EntryMetadata = Record<string, MetadataValue>;

export interface BaseEntry {
  meta: EntryMetadata;
  source?: SourceLocation;
}

export interface BaseDatedEntry extends BaseEntry {
  date: string;
}

export interface OpenEntry extends BaseDatedEntry {
  type: "open";
  account: string;
  currencies: string[];
  booking: Booking | null;
}

export interface CloseEntry extends BaseDatedEntry {
  type: "close";
  account: string;
}

export interface CommodityEntry extends BaseDatedEntry {
  type: "commodity";
  currency: string;
}

export interface PadEntry extends BaseDatedEntry {
  type: "pad";
  account: string;
  sourceAccount: string;
}

export interface BalanceEntry extends BaseDatedEntry {
  type: "balance";
  account: string;
  amount: Amount;
  tolerance: Amount | null;
}

export interface PostingEntry {
  account: string;
  units: Amount | null;
  cost: Cost | CostSpec | null;
  price: Amount | null;
  priceIsTotal: boolean;
  flag: string | null;
  meta: EntryMetadata;
}

export interface TransactionEntry extends BaseDatedEntry {
  type: "transaction";
  flag: string;
  payee: string | null;
  narration: string | null;
  tags: Set<string>;
  links: Set<string>;
  postings: PostingEntry[];
}

export interface NoteEntry extends BaseDatedEntry {
  type: "note";
  account: string;
  comment: string;
  tags: Set<string>;
  links: Set<string>;
}

export interface EventEntry extends BaseDatedEntry {
  type: "event";
  eventType: string;
  description: string;
}

export interface QueryEntry extends BaseDatedEntry {
  type: "query";
  name: string;
  queryString: string;
}

export interface PriceEntry extends BaseDatedEntry {
  type: "price";
  currency: string;
  amount: Amount;
}

export interface DocumentEntry extends BaseDatedEntry {
  type: "document";
  account: string;
  filename: string;
  tags: Set<string>;
  links: Set<string>;
}

export interface CustomEntry extends BaseDatedEntry {
  type: "custom";
  customType: string;
  values: string[];
}

export interface OptionEntry extends BaseEntry {
  type: "option";
  name: string;
  value: string;
}

export interface IncludeEntry extends BaseEntry {
  type: "include";
  path: string;
}

export interface PluginEntry extends BaseEntry {
  type: "plugin";
  module: string;
  config: string | null;
}

export interface TagStackEntry extends BaseEntry {
  type: "pushtag" | "poptag";
  tag: string;
}

export interface MetaStackEntry extends BaseEntry {
  type: "pushmeta" | "popmeta";
  key: string;
  value: string | null;
}

export type ConfigEntry =
  | OptionEntry
  | IncludeEntry
  | PluginEntry
  | TagStackEntry
  | MetaStackEntry;

export type LedgerEntry =
  | OpenEntry
  | CloseEntry
  | CommodityEntry
  | PadEntry
  | BalanceEntry
  | TransactionEntry
  | NoteEntry
  | EventEntry
  | QueryEntry
  | PriceEntry
  | DocumentEntry
  | CustomEntry
  | ConfigEntry;

export type DatedEntry = Exclude<LedgerEntry, ConfigEntry>;

export interface LedgerError {
  code: string;
  message: string;
  source?: SourceLocation;
}

export interface LedgerLoadResult {
  entries: LedgerEntry[];
  errors: LedgerError[];
  options: Record<string, string>;
}

export function isDatedEntry(entry: LedgerEntry): entry is DatedEntry {
  return "date" in entry;
}
