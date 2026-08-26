import { createHash } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import { redactSecretPatterns } from "../runs/evidenceRedaction.js";

export interface ResearchArtifactRecord { id: string; artifact_type: string; content: string | null }
export interface ResearchArtifactValidationFailure {
  code: "research_artifacts_missing" | "research_artifact_missing_content" | "research_artifact_invalid_json" | "research_artifact_schema_invalid";
  message: string;
  diagnostics: Record<string, unknown>;
}
export type ResearchArtifactValidationResult =
  | { ok: true; report: Record<string, unknown>; archive: ResearchArtifactRecord }
  | { ok: false; failure: ResearchArtifactValidationFailure };

export async function validateResearchArtifacts(artifacts: ResearchArtifactRecord[]): Promise<ResearchArtifactValidationResult> {
  const archive = artifacts.find((item) => item.artifact_type === "research_report.archive.v1");
  if (!archive) return failure("research_artifacts_missing", "Synthesis output is missing research_report.archive.v1", null, "missing_archive");
  if (!archive.content) return failure("research_artifact_missing_content", "Research report archive has no inline JSON content", archive, "empty_content");
  const parsed = parseJson(archive.content);
  if (!parsed.ok) return failure("research_artifact_invalid_json", "Research report archive is not valid JSON", archive, parsed.error);
  const result = protocol.ResearchReportV1Schema.safeParse(parsed.value);
  if (!result.success) return failure("research_artifact_schema_invalid", `Research report failed schema validation: ${result.error.message}`, archive, result.error.message);
  return { ok: true, report: result.data as Record<string, unknown>, archive };
}

function parseJson(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(content) }; }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

function failure(code: ResearchArtifactValidationFailure["code"], message: string, artifact: ResearchArtifactRecord | null, schemaError: string): ResearchArtifactValidationResult {
  const content = artifact?.content ?? "";
  return { ok: false, failure: { code, message, diagnostics: {
    artifact_id: artifact?.id ?? null,
    artifact_type: artifact?.artifact_type ?? "research_report.archive.v1",
    content_length: content.length,
    content_sha256: content ? createHash("sha256").update(content).digest("hex") : null,
    content_preview: content ? redactSecretPatterns(content.slice(0, 240)) : null,
    schema_error: schemaError,
  } } };
}
