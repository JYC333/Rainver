import { Amount, assertCommoditySymbol, isCommoditySymbol } from "../domain/amount.js";
import { parseBooking } from "../domain/booking.js";
import { Cost, CostSpec } from "../domain/position.js";
import type {
  EntryMetadata,
  MetadataValue,
  BalanceEntry,
  CloseEntry,
  CommodityEntry,
  ConfigEntry,
  CustomEntry,
  DocumentEntry,
  EventEntry,
  IncludeEntry,
  LedgerEntry,
  LedgerError,
  NoteEntry,
  OpenEntry,
  PadEntry,
  PluginEntry,
  PostingEntry,
  PriceEntry,
  QueryEntry,
  TransactionEntry,
} from "./entries.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BeancountImportResult {
  entries: LedgerEntry[];
  errors: LedgerError[];
  options: Record<string, string>;
}

const METADATA_LINE_RE = /^\s+([a-z][A-Za-z0-9_-]*):\s*(.*)$/;

export function parseBeancountText(text: string, filename = "<input>"): BeancountImportResult {
  const entries: LedgerEntry[] = [];
  const errors: LedgerError[] = [];
  const options: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const activeTags = new Set<string>();
  const activeMeta: EntryMetadata = {};

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const lineno = index + 1;
    if (isIgnorable(line)) {
      index += 1;
      continue;
    }

    if (/^\s/.test(line)) {
      errors.push({ code: "unexpected_indentation", message: "Unexpected posting line", source: { filename, lineno } });
      index += 1;
      continue;
    }

    try {
      const parsed = parseTopLevelLine(line, filename, lineno);
      if (parsed.entry.type === "transaction") {
        const transaction = parsed.entry;
        for (const tag of activeTags) transaction.tags.add(tag);
        Object.assign(transaction.meta, activeMeta);
        const postings: PostingEntry[] = [];
        index += 1;
        while (index < lines.length && (/^\s/.test(lines[index]!) || isIgnorable(lines[index]!))) {
          if (!isIgnorable(lines[index]!)) {
            const bodyLine = lines[index]!;
            const metaMatch = stripComment(bodyLine).match(METADATA_LINE_RE);
            if (metaMatch) {
              const target = postings.at(-1)?.meta ?? transaction.meta;
              target[metaMatch[1]!] = parseMetadataValue(metaMatch[2]!.trim());
            } else {
              postings.push(parsePostingLine(bodyLine, filename, index + 1));
            }
          }
          index += 1;
        }
        entries.push({ ...transaction, postings });
      } else {
        entries.push(parsed.entry);
        if (parsed.entry.type === "option") options[parsed.entry.name] = parsed.entry.value;
        if (parsed.entry.type === "pushtag") activeTags.add(parsed.entry.tag);
        if (parsed.entry.type === "poptag") activeTags.delete(parsed.entry.tag);
        if (parsed.entry.type === "pushmeta") activeMeta[parsed.entry.key] = parsed.entry.value;
        if (parsed.entry.type === "popmeta") delete activeMeta[parsed.entry.key];
        index += 1;
      }
    } catch (err) {
      errors.push({
        code: "parse_error",
        message: err instanceof Error ? err.message : "Parse error",
        source: { filename, lineno },
      });
      index += 1;
    }
  }

  return { entries, errors, options };
}

function parseMetadataValue(raw: string): MetadataValue {
  if (raw === "") return null;
  if (raw.startsWith('"')) return unquote(raw);
  if (raw === "TRUE") return true;
  if (raw === "FALSE") return false;
  return raw;
}

function parseTopLevelLine(
  line: string,
  filename: string,
  lineno: number,
): { entry: LedgerEntry } {
  const source = { filename, lineno };
  const trimmed = stripComment(line).trim();
  const config = parseConfigLine(trimmed, filename, lineno);
  if (config) return { entry: config };

  const [date, rest] = splitFirst(trimmed);
  if (!DATE_RE.test(date)) throw new Error(`Expected date at line ${lineno}`);
  const [directive, tail] = splitFirst(rest);

  switch (directive) {
    case "open":
      return { entry: parseOpen(date, tail, source) };
    case "close":
      return { entry: { type: "close", date, account: tail.trim(), meta: {}, source } satisfies CloseEntry };
    case "commodity":
      assertCommoditySymbol(tail.trim());
      return { entry: { type: "commodity", date, currency: tail.trim(), meta: {}, source } satisfies CommodityEntry };
    case "pad": {
      const [account, sourceAccount] = splitFirst(tail);
      return { entry: { type: "pad", date, account, sourceAccount, meta: {}, source } satisfies PadEntry };
    }
    case "balance":
      return { entry: parseBalance(date, tail, source) };
    case "price":
      return { entry: parsePrice(date, tail, source) };
    case "note":
      return { entry: parseNote(date, tail, source) };
    case "event":
      return { entry: parseEvent(date, tail, source) };
    case "query":
      return { entry: parseQuery(date, tail, source) };
    case "document":
      return { entry: parseDocument(date, tail, source) };
    case "custom":
      return { entry: parseCustom(date, tail, source) };
    default:
      if (directive !== "txn" && directive.length !== 1) {
        throw new Error(`Unknown directive or flag: ${directive}`);
      }
      return { entry: parseTransaction(date, directive, tail, source) };
  }
}

function parseConfigLine(line: string, filename: string, lineno: number): ConfigEntry | null {
  const source = { filename, lineno };
  if (line.startsWith("option ")) {
    const values = quotedValues(line.slice("option ".length));
    if (values.length < 2) throw new Error("option requires name and value");
    return { type: "option", name: values[0]!, value: values[1]!, meta: {}, source };
  }
  if (line.startsWith("include ")) {
    const [path] = quotedValues(line.slice("include ".length));
    if (!path) throw new Error("include requires path");
    return { type: "include", path, meta: {}, source } satisfies IncludeEntry;
  }
  if (line.startsWith("plugin ")) {
    const values = quotedValues(line.slice("plugin ".length));
    if (!values[0]) throw new Error("plugin requires module");
    return { type: "plugin", module: values[0], config: values[1] ?? null, meta: {}, source } satisfies PluginEntry;
  }
  if (line.startsWith("pushtag ")) {
    return { type: "pushtag", tag: line.slice("pushtag ".length).replace(/^#/, ""), meta: {}, source };
  }
  if (line.startsWith("poptag ")) {
    return { type: "poptag", tag: line.slice("poptag ".length).replace(/^#/, ""), meta: {}, source };
  }
  if (line.startsWith("pushmeta ")) {
    const [key, value] = splitFirst(line.slice("pushmeta ".length));
    return { type: "pushmeta", key: key.replace(/:$/, ""), value: unquote(value.trim()), meta: {}, source };
  }
  if (line.startsWith("popmeta ")) {
    return { type: "popmeta", key: line.slice("popmeta ".length).replace(/:$/, ""), value: null, meta: {}, source };
  }
  return null;
}

function parseOpen(date: string, tail: string, source: { filename: string; lineno: number }): OpenEntry {
  const [account, rest] = splitFirst(tail);
  const parts = rest.split(/\s+/).filter(Boolean);
  const bookingToken = parts.find((part) => part in Object.fromEntries([
    ["STRICT", true],
    ["STRICT_WITH_SIZE", true],
    ["NONE", true],
    ["AVERAGE", true],
    ["FIFO", true],
    ["LIFO", true],
    ["HIFO", true],
  ]));
  const currencies = parts
    .filter((part) => part !== bookingToken)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  currencies.forEach(assertCommoditySymbol);
  return {
    type: "open",
    date,
    account,
    currencies,
    booking: parseBooking(bookingToken),
    meta: {},
    source,
  };
}

function parseBalance(date: string, tail: string, source: { filename: string; lineno: number }): BalanceEntry {
  const parts = tail.split(/\s+/).filter(Boolean);
  if (parts.length < 3) throw new Error("balance requires account, number, and currency");
  const account = parts[0]!;
  const amount = Amount.of(parts[1]!, parts[2]!);
  let tolerance: Amount | null = null;
  const toleranceIndex = parts.indexOf("~");
  if (toleranceIndex >= 0) {
    tolerance = Amount.of(parts[toleranceIndex + 1]!, amount.currency);
  }
  return { type: "balance", date, account, amount, tolerance, meta: {}, source };
}

function parsePrice(date: string, tail: string, source: { filename: string; lineno: number }): PriceEntry {
  const parts = tail.split(/\s+/).filter(Boolean);
  if (parts.length < 3) throw new Error("price requires currency and amount");
  assertCommoditySymbol(parts[0]!);
  return { type: "price", date, currency: parts[0]!, amount: Amount.of(parts[1]!, parts[2]!), meta: {}, source };
}

function parseTransaction(
  date: string,
  flag: string,
  tail: string,
  source: { filename: string; lineno: number },
): TransactionEntry {
  const values = quotedValues(tail);
  const payee = values.length >= 2 ? values[0]! : null;
  const narration = values.length >= 2 ? values[1]! : values[0] ?? null;
  return {
    type: "transaction",
    date,
    flag: flag === "txn" ? "*" : flag,
    payee,
    narration,
    tags: new Set([...tail.matchAll(/(?:^|\s)#([A-Za-z0-9_-]+)/g)].map((match) => match[1]!)),
    links: new Set([...tail.matchAll(/(?:^|\s)\^([A-Za-z0-9_-]+)/g)].map((match) => match[1]!)),
    postings: [],
    meta: {},
    source,
  };
}

function parsePostingLine(line: string, filename: string, lineno: number): PostingEntry {
  const stripped = stripComment(line).trim();
  const costMatch = stripped.match(/\{\{?([^}]*)\}?\}/);
  const cost = costMatch ? parseCost(costMatch[1]!.trim(), costMatch[0]!.startsWith("{{")) : null;
  const trimmed = costMatch ? stripped.replace(costMatch[0]!, " ").replace(/\s+/g, " ").trim() : stripped;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  let flag: string | null = null;
  let account = parts.shift();
  if (account && /^[*!#?]$/.test(account)) {
    flag = account;
    account = parts.shift();
  }
  if (!account) throw new Error("posting requires account");
  if (parts.length === 0) {
    return { account, units: null, cost, price: null, priceIsTotal: false, flag, meta: {} };
  }

  const units = Amount.of(parts[0]!, parts[1]!);
  const priceIndex = parts.findIndex((part) => part === "@" || part === "@@");
  const price = priceIndex >= 0 ? Amount.of(parts[priceIndex + 1]!, parts[priceIndex + 2]!) : null;
  return {
    account,
    units,
    cost,
    price,
    priceIsTotal: priceIndex >= 0 && parts[priceIndex] === "@@",
    flag,
    meta: {},
  };
}

const DECIMAL_TOKEN_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

// Parses the inside of a `{...}` or `{{...}}` cost annotation. A fully
// specified per-unit cost becomes a Cost; anything partial stays a CostSpec
// for booking-time resolution.
function parseCost(content: string, isTotal: boolean): Cost | CostSpec {
  let numberPer: string | null = null;
  let numberTotal: string | null = null;
  let currency: string | null = null;
  let date: string | null = null;
  let label: string | null = null;
  let merge: boolean | null = null;

  for (const part of content.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    if (part === "*") {
      merge = true;
      continue;
    }
    if (DATE_RE.test(part)) {
      date = part;
      continue;
    }
    if (part.startsWith('"')) {
      label = unquote(part);
      continue;
    }
    const tokens = part.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token === "#") {
        numberTotal = tokens[i + 1] ?? null;
        i += 1;
      } else if (DECIMAL_TOKEN_RE.test(token)) {
        if (isTotal) numberTotal = token;
        else numberPer = token;
      } else if (isCommoditySymbol(token)) {
        currency = token;
      } else {
        throw new Error(`Invalid cost component: ${token}`);
      }
    }
  }

  if (numberPer && currency && !numberTotal && !merge) {
    return new Cost({ number: numberPer, currency, date, label });
  }
  return new CostSpec({ numberPer, numberTotal, currency, date, label, merge });
}

function parseNote(date: string, tail: string, source: { filename: string; lineno: number }): NoteEntry {
  const [account, rest] = splitFirst(tail);
  return { type: "note", date, account, comment: unquote(rest.trim()), tags: new Set(), links: new Set(), meta: {}, source };
}

function parseEvent(date: string, tail: string, source: { filename: string; lineno: number }): EventEntry {
  const values = quotedValues(tail);
  return { type: "event", date, eventType: values[0] ?? "", description: values[1] ?? "", meta: {}, source };
}

function parseQuery(date: string, tail: string, source: { filename: string; lineno: number }): QueryEntry {
  const values = quotedValues(tail);
  return { type: "query", date, name: values[0] ?? "", queryString: values[1] ?? "", meta: {}, source };
}

function parseDocument(date: string, tail: string, source: { filename: string; lineno: number }): DocumentEntry {
  const [account, rest] = splitFirst(tail);
  return { type: "document", date, account, filename: unquote(rest.trim()), tags: new Set(), links: new Set(), meta: {}, source };
}

function parseCustom(date: string, tail: string, source: { filename: string; lineno: number }): CustomEntry {
  const [customType, rest] = splitFirst(tail);
  return { type: "custom", date, customType: unquote(customType), values: rest.split(/\s+/).filter(Boolean), meta: {}, source };
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith(";");
}

function stripComment(line: string): string {
  const index = line.indexOf(";");
  return index === -1 ? line : line.slice(0, index);
}

function splitFirst(input: string): readonly [string, string] {
  const trimmed = input.trim();
  const index = trimmed.search(/\s/);
  if (index === -1) return [trimmed, ""];
  return [trimmed.slice(0, index), trimmed.slice(index + 1).trimStart()];
}

function quotedValues(input: string): string[] {
  return [...input.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1]!.replace(/\\"/g, '"'),
  );
}

function unquote(input: string): string {
  if (input.startsWith('"') && input.endsWith('"')) return input.slice(1, -1).replace(/\\"/g, '"');
  return input;
}
