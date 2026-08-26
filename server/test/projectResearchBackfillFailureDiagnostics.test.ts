import { describe, expect, it } from "vitest";
import {
  backfillCanProceed,
  summarizeBackfillFailures,
} from "../src/modules/projectResearch/backfillFailureDiagnostics.js";

describe("Project Research backfill failure diagnostics", () => {
  it("presents provider retry evidence without copying query or endpoint data", () => {
    const result = summarizeBackfillFailures([{
      plan_id: "plan-1",
      segment_id: "segment-1",
      source_channel_id: "channel-1",
      provider_key: "arxiv",
      provider_display_name: "arXiv",
      attempt_count: 1,
      error_json: {
        code: "503",
        message: "arXiv history import failed after 2 attempts",
        extraction_job_id: "job-1",
        diagnostics: {
          provider_key: "arxiv",
          provider_display_name: "arXiv",
          connector_key: "arxiv_api",
          upstream_status: 500,
          attempts: 2,
          retryable: true,
          failure_kind: "upstream_http",
          endpoint_url: "must-not-leak",
          search_query: "must-not-leak",
        },
      },
    }]);

    expect(result).toMatchObject({
      code: "source_history_backfill_failed",
      diagnostics: {
        retryable: true,
        failed_source_count: 1,
        failed_sources: [{
          provider_key: "arxiv",
          provider_display_name: "arXiv",
          upstream_status: 500,
          automatic_attempts: 2,
          plan_id: "plan-1",
          segment_id: "segment-1",
          extraction_job_id: "job-1",
        }],
      },
    });
    expect(result.message).toContain("arXiv");
    expect(result.message).toContain("2 automatic attempts");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("continues with collected providers while a transient source retries in the background", () => {
    const completed = { status: "completed", items_ingested: 10, error_json: null };
    const deferred = {
      status: "paused",
      items_ingested: 0,
      error_json: { code: "source_backfill_deferred" },
    };
    expect(backfillCanProceed([completed, deferred], 2)).toBe(true);
    expect(backfillCanProceed([deferred], 1)).toBe(false);
    expect(backfillCanProceed([{ ...deferred, items_ingested: 3 }], 1)).toBe(true);
    expect(backfillCanProceed([completed, { status: "running", items_ingested: 0, error_json: null }], 2)).toBe(false);
    expect(backfillCanProceed([completed], 2)).toBe(false);
  });
});

/**
 * A provider that answered slowly and one that could not be reached produced
 * the same sentence, which is what made a 30s arXiv 5xx read as a network
 * outage. The wording now follows the recorded failure kind.
 */
describe("backfill failure wording by failure kind", () => {
  const row = (diagnostics: Record<string, unknown>) => ({
    plan_id: "plan-1",
    segment_id: "segment-1",
    source_channel_id: "channel-1",
    provider_key: "arxiv",
    provider_display_name: "arXiv",
    attempt_count: 2,
    error_json: { code: "source_backfill_deferred", message: "deferred", diagnostics },
  });

  it("says a slow provider did not answer in time", () => {
    const summary = summarizeBackfillFailures([row({
      provider_key: "arxiv", provider_display_name: "arXiv", failure_kind: "timeout",
      upstream_status: null, attempts: 2, retryable: true,
      error_name: "TimeoutError", elapsed_ms: 35_000, timeout_ms: 35_000,
      page_sizes_attempted: [100, 25, 10],
    })]);
    expect(summary.message).toContain("did not answer in time");
    expect(summary.message).not.toContain("could not be reached");
    const failed = (summary.diagnostics.failed_sources as Array<Record<string, unknown>>)[0]!;
    expect(failed).toMatchObject({
      failure_kind: "timeout",
      transport_error_name: "TimeoutError",
      page_sizes_attempted: [100, 25, 10],
      // The Source-layer code stays distinct from the transport one.
      error_code: "source_backfill_deferred",
    });
  });

  it("still says unreachable when nothing answered", () => {
    const summary = summarizeBackfillFailures([row({
      provider_key: "arxiv", provider_display_name: "arXiv", failure_kind: "network",
      upstream_status: null, attempts: 2, retryable: true, error_code: "ENOTFOUND",
    })]);
    expect(summary.message).toContain("could not be reached");
    const failed = (summary.diagnostics.failed_sources as Array<Record<string, unknown>>)[0]!;
    expect(failed).toMatchObject({ transport_error_code: "ENOTFOUND" });
  });
});
