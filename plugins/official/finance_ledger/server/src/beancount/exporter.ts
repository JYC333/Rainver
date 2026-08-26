import { CostSpec } from "../domain/position.js";
import type {
  BalanceEntry,
  EntryMetadata,
  LedgerEntry,
  PostingEntry,
  TransactionEntry,
} from "./entries.js";
import { isDatedEntry } from "./entries.js";
import { sortEntries } from "./sort.js";

export class BeancountExporter {
  export(entries: readonly LedgerEntry[], options: Record<string, string> = {}): string {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(options).sort()) {
      lines.push(`option "${escapeString(name)}" "${escapeString(value)}"`);
    }
    if (lines.length > 0) lines.push("");

    for (const entry of sortEntries(entries)) {
      lines.push(...this.formatEntry(entry));
      if (isDatedEntry(entry) && entry.type !== "transaction") {
        lines.push(...formatMetadata(entry.meta, 2));
      }
      lines.push("");
    }
    while (lines.at(-1) === "") lines.pop();
    return `${lines.join("\n")}\n`;
  }

  private formatEntry(entry: LedgerEntry): string[] {
    switch (entry.type) {
      case "option":
        return [`option "${escapeString(entry.name)}" "${escapeString(entry.value)}"`];
      case "include":
        return [`include "${escapeString(entry.path)}"`];
      case "plugin":
        return [`plugin "${escapeString(entry.module)}"${entry.config ? ` "${escapeString(entry.config)}"` : ""}`];
      case "pushtag":
      case "poptag":
        return [`${entry.type} #${entry.tag}`];
      case "pushmeta":
        return [`pushmeta ${entry.key}: ${entry.value == null ? "" : `"${escapeString(entry.value)}"`}`.trimEnd()];
      case "popmeta":
        return [`popmeta ${entry.key}:`];
      case "open":
        return [
          `${entry.date} open ${entry.account}${entry.currencies.length ? ` ${entry.currencies.join(",")}` : ""}${entry.booking ? ` ${entry.booking}` : ""}`,
        ];
      case "close":
        return [`${entry.date} close ${entry.account}`];
      case "commodity":
        return [`${entry.date} commodity ${entry.currency}`];
      case "pad":
        return [`${entry.date} pad ${entry.account} ${entry.sourceAccount}`];
      case "balance":
        return [formatBalance(entry)];
      case "transaction":
        return this.formatTransaction(entry);
      case "note":
        return [`${entry.date} note ${entry.account} "${escapeString(entry.comment)}"`];
      case "event":
        return [`${entry.date} event "${escapeString(entry.eventType)}" "${escapeString(entry.description)}"`];
      case "query":
        return [`${entry.date} query "${escapeString(entry.name)}" "${escapeString(entry.queryString)}"`];
      case "price":
        return [`${entry.date} price ${entry.currency} ${entry.amount.toString()}`];
      case "document":
        return [`${entry.date} document ${entry.account} "${escapeString(entry.filename)}"`];
      case "custom":
        return [`${entry.date} custom "${escapeString(entry.customType)}" ${entry.values.join(" ")}`.trimEnd()];
    }
  }

  private formatTransaction(entry: TransactionEntry): string[] {
    const headerParts = [`${entry.date} ${entry.flag}`];
    if (entry.payee) headerParts.push(`"${escapeString(entry.payee)}"`);
    if (entry.narration) headerParts.push(`"${escapeString(entry.narration)}"`);
    for (const tag of [...entry.tags].sort()) headerParts.push(`#${tag}`);
    for (const link of [...entry.links].sort()) headerParts.push(`^${link}`);
    return [
      headerParts.join(" "),
      ...formatMetadata(entry.meta, 2),
      ...entry.postings.flatMap((posting) => [
        formatPosting(posting),
        ...formatMetadata(posting.meta, 4),
      ]),
    ];
  }
}

function formatBalance(entry: BalanceEntry): string {
  const tolerance = entry.tolerance ? ` ~ ${entry.tolerance.number.decimal}` : "";
  return `${entry.date} balance ${entry.account} ${entry.amount.toString()}${tolerance}`;
}

function formatPosting(posting: PostingEntry): string {
  const flag = posting.flag ? `${posting.flag} ` : "";
  const units = posting.units ? `  ${posting.units.toString()}` : "";
  const cost = posting.cost
    ? posting.cost instanceof CostSpec && posting.cost.numberTotal && !posting.cost.numberPer
      ? ` {{${posting.cost.numberTotal.decimal}${posting.cost.currency ? ` ${posting.cost.currency}` : ""}}}`
      : ` {${posting.cost.toString()}}`
    : "";
  const price = posting.price ? ` ${posting.priceIsTotal ? "@@" : "@"} ${posting.price.toString()}` : "";
  return `  ${flag}${posting.account}${units}${cost}${price}`;
}

const INTERNAL_META_KEYS = new Set(["filename", "lineno", "interpolated", "generated_by"]);

function formatMetadata(meta: EntryMetadata, indent: number): string[] {
  return Object.entries(meta)
    .filter(([key]) => !INTERNAL_META_KEYS.has(key))
    .map(([key, value]) => `${" ".repeat(indent)}${key}: ${formatMetadataValue(value)}`);
}

function formatMetadataValue(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return `"${escapeString(value)}"`;
}

function escapeString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
