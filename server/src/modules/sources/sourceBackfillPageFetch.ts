import { HttpError } from "../routeUtils/common.js";
import { backfillFetchTimeoutMs, isNarrowableFailure, SourceFetchFailure } from "./sourceConnectionFetch.js";
import type { SourceFetchResult } from "./sourceFetch.js";

/**
 * How far to climb down when a provider cannot answer a full history page.
 *
 * A provider that returns 5xx or stops answering on a 100-row page of a broad
 * boolean query will often serve the same query at 25 rows without complaint —
 * the query is valid, the answer is just too expensive to assemble. Failing the
 * whole segment there discards one source's entire contribution to a research
 * run, and Research then reports a confident "no relevant material" over a
 * corpus that is missing half its inputs. A slower import is the better trade.
 *
 * Quartering rather than halving keeps a doomed segment to three attempts, and
 * the floor exists because a page small enough to need hundreds of requests is
 * its own kind of failure.
 */
export const PAGE_SIZE_FLOOR = 10;
const NARROWING_FACTOR = 4;

export function pageSizeLadder(requested: number): number[] {
  const first = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : PAGE_SIZE_FLOOR;
  const ladder = [first];
  for (;;) {
    const previous = ladder[ladder.length - 1]!;
    if (previous <= PAGE_SIZE_FLOOR) break;
    const next = Math.max(PAGE_SIZE_FLOOR, Math.floor(previous / NARROWING_FACTOR));
    if (next >= previous) break;
    ladder.push(next);
  }
  return ladder;
}

export interface BackfillPageRequest {
  url: string;
  headers: Record<string, string>;
  /** Kept apart from `headers` so it stops at the first origin; see `fetchSource`. */
  credentialHeaders?: Record<string, string>;
}

export interface BackfillPageResult {
  response: SourceFetchResult;
  request: BackfillPageRequest;
  /** The width that actually worked, which the caller carries into the next page. */
  pageSize: number;
  attemptedPageSizes: number[];
}

/**
 * Fetches one history page, stepping down the page size when — and only when —
 * the provider failed in a way a smaller ask can fix.
 *
 * Narrowing is gated by the connector's paging model rather than attempted
 * everywhere: re-asking a page-numbered API for fewer rows returns a different
 * slice, so a "recovery" there would quietly skip results.
 */
export async function fetchBackfillPageWithNarrowing(input: {
  window: Record<string, unknown>;
  requestedPageSize: number;
  narrowingAllowed: boolean;
  buildRequest: (window: Record<string, unknown>) => BackfillPageRequest;
  fetchPage: (request: BackfillPageRequest & { timeoutMs: number }) => Promise<SourceFetchResult>;
}): Promise<BackfillPageResult> {
  const ladder = input.narrowingAllowed ? pageSizeLadder(input.requestedPageSize) : [input.requestedPageSize];
  const attemptedPageSizes: number[] = [];
  for (const [index, pageSize] of ladder.entries()) {
    const request = input.buildRequest({ ...input.window, page_size: pageSize, max_items: pageSize });
    attemptedPageSizes.push(pageSize);
    try {
      const response = await input.fetchPage({ ...request, timeoutMs: backfillFetchTimeoutMs(pageSize) });
      return { response, request, pageSize, attemptedPageSizes };
    } catch (error) {
      if (index === ladder.length - 1 || !isNarrowableFailure(error)) {
        throw annotateNarrowingAttempts(error, attemptedPageSizes);
      }
    }
  }
  throw new HttpError(500, "Unreachable backfill page ladder state");
}

/**
 * Records which widths were tried, so a failure that survived every rung says
 * so in the persisted diagnostics instead of looking like a single attempt.
 */
function annotateNarrowingAttempts(error: unknown, pageSizes: number[]): unknown {
  if (error instanceof SourceFetchFailure && pageSizes.length > 1) {
    return new SourceFetchFailure(error.statusCode, error.message, {
      ...error.diagnostics,
      page_sizes_attempted: pageSizes,
    } as typeof error.diagnostics);
  }
  return error;
}

/**
 * How many of a history page's items count against the segment: the page
 * width, capped at what is left of the segment's budget.
 */
export function backfillPageItemLimit(window: Record<string, unknown>): number {
  const pageSize = wholeNumber(window.page_size ?? window.remaining_items ?? window.max_items) ?? 100;
  const remaining = wholeNumber(window.remaining_items);
  return Math.min(100, Math.max(1, remaining === null ? pageSize : Math.min(pageSize, remaining)));
}

/**
 * The segment window after one history page. A short page means the provider
 * has nothing more; reaching the segment's budget leaves it partial; anything
 * else queues the next page at the item offset the pages so far reached
 * (`window` is then that next page's window).
 *
 * Only a connector whose offset is counted in items may shrink the next page
 * to the remaining budget. A page-numbered API (OpenAlex) answers the same page
 * number at a narrower width with a different slice, so it keeps its width and
 * the worker keeps only the first `remaining_items` of the last page.
 */
export function nextBackfillWindow(
  window: Record<string, unknown>,
  page: { seen: number; pageSize: number; narrowable: boolean },
): { outcome: "exhausted" | "partial" | "continue"; window: Record<string, unknown> } {
  const consumedItems = (wholeNumber(window.consumed_items) ?? 0) + page.seen;
  const budget = wholeNumber(window.max_items);
  const remaining = wholeNumber(window.remaining_items ?? window.max_items);
  const budgetReached = remaining !== null && remaining <= page.seen;
  if (page.seen < page.pageSize && !budgetReached) {
    return {
      outcome: "exhausted",
      window: { ...window, consumed_items: consumedItems, next_cursor: null, has_more: false, exhausted: true },
    };
  }
  if (budget === null || remaining === null || budgetReached) {
    // A page cut short by the budget was not read to its end, so a later
    // continuation of a page-numbered connector starts on that page again.
    const pageCursor = wholeNumber(window.cursor) ?? 0;
    return {
      outcome: "partial",
      window: {
        ...window,
        consumed_items: consumedItems,
        next_cursor: page.seen < page.pageSize ? pageCursor : pageCursor + 1,
        has_more: true,
        exhausted: false,
        partial: true,
      },
    };
  }
  const nextRemaining = remaining - page.seen;
  const cursor = (wholeNumber(window.cursor) ?? 0) + 1;
  return {
    outcome: "continue",
    window: {
      ...window,
      cursor,
      // Item offset is the authority for where the next page starts. Page index
      // times a fixed width was wrong for any page that was not full width.
      offset: consumedItems,
      remaining_items: nextRemaining,
      // Stay at the width the provider just proved it can serve. Returning to
      // the full page would re-earn the same failure on every subsequent page.
      page_size: page.narrowable ? Math.min(page.pageSize, nextRemaining) : page.pageSize,
      consumed_items: consumedItems,
    },
  };
}

function wholeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
