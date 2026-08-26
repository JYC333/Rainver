import type { DatedEntry, LedgerEntry } from "./entries.js";
import { isDatedEntry } from "./entries.js";

const SORT_ORDER: Partial<Record<DatedEntry["type"], number>> = {
  open: -2,
  balance: -1,
  document: 1,
  close: 2,
};

export function entrySortKey(entry: DatedEntry): readonly [string, number, number] {
  return [entry.date, SORT_ORDER[entry.type] ?? 0, entry.source?.lineno ?? 0] as const;
}

export function sortEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const configEntries = entries.filter((entry) => !isDatedEntry(entry));
  const datedEntries = entries
    .filter(isDatedEntry)
    .sort((left, right) => compareSortKey(entrySortKey(left), entrySortKey(right)));
  return [...configEntries, ...datedEntries];
}

function compareSortKey(
  left: readonly [string, number, number],
  right: readonly [string, number, number],
): number {
  if (left[0] !== right[0]) return left[0].localeCompare(right[0]);
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}
