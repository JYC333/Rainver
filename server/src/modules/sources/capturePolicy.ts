export const SOURCE_CAPTURE_POLICIES = [
  "reference_only",
  "extract_text",
  "archive_original",
] as const;

export type SourceCapturePolicy = (typeof SOURCE_CAPTURE_POLICIES)[number];

export const SOURCE_CAPTURE_POLICY_SET = new Set<string>(SOURCE_CAPTURE_POLICIES);

export function parseSourceCapturePolicy(value: string): SourceCapturePolicy | null {
  return SOURCE_CAPTURE_POLICY_SET.has(value) ? (value as SourceCapturePolicy) : null;
}

export const SOURCE_CAPTURE_POLICY_RANK: Record<SourceCapturePolicy, number> = {
  reference_only: 0,
  extract_text: 1,
  archive_original: 2,
};

export const SOURCE_RETENTION_POLICIES = [
  "metadata_only",
  "summary_only",
  "full_text",
  "full_snapshot",
  "archived",
] as const;

export type SourceRetentionPolicy = (typeof SOURCE_RETENTION_POLICIES)[number];

const SOURCE_RETENTION_POLICY_SET = new Set<string>(SOURCE_RETENTION_POLICIES);

export function parseSourceRetentionPolicy(value: string): SourceRetentionPolicy | null {
  return SOURCE_RETENTION_POLICY_SET.has(value) ? (value as SourceRetentionPolicy) : null;
}

export function retentionForCapturePolicy(capturePolicy: SourceCapturePolicy): SourceRetentionPolicy {
  if (capturePolicy === "archive_original") return "full_snapshot";
  if (capturePolicy === "extract_text") return "full_text";
  return "metadata_only";
}

export function capturePolicyScanState(capturePolicy: string): {
  contentState: "metadata_only" | "content_queued" | "snapshot_queued";
  retention: SourceRetentionPolicy;
  followUpJobType: "extract_text" | "snapshot" | null;
} {
  if (capturePolicy === "extract_text") {
    return { contentState: "content_queued", retention: "full_text", followUpJobType: "extract_text" };
  }
  if (capturePolicy === "archive_original") {
    return { contentState: "snapshot_queued", retention: "full_snapshot", followUpJobType: "snapshot" };
  }
  return { contentState: "metadata_only", retention: "metadata_only", followUpJobType: null };
}
