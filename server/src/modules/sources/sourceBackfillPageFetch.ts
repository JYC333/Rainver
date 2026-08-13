import { HttpError } from "../routeUtils/common";
import { backfillFetchTimeoutMs, isNarrowableFailure, SourceFetchFailure } from "./sourceConnectionFetch";
import type { SourceFetchResult } from "./sourceFetch";

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
