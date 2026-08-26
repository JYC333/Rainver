import type { RunMaterializationItemSummary } from "@rainver/protocol";
import type { RunRecord } from "../repository.js";

export const VERIFICATION_ENGINE_VERSION = "verification_engine.v1" as const;

export type VerificationStatus = "passed" | "failed" | "skipped" | "error";

export type VerifierType =
  | "command"
  | "test"
  | "lint"
  | "typecheck"
  | "file_exists"
  | "file_changed"
  | "diff_scope"
  | "artifact_exists"
  | "artifact_schema"
  | "output_schema"
  | "proposal_created"
  | "no_forbidden_change"
  | "recipe_ref"
  | "manual_review"
  | "model_judge";

export interface VerificationResultRecord {
  id: string;
  space_id: string;
  run_id: string;
  attempt_number: number;
  verifier_type: string;
  verifier_version: string;
  status: VerificationStatus;
  summary: string | null;
  evidence_refs_json: unknown;
  details_json: unknown;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface VerificationDeclaration {
  verifier_type: VerifierType | string;
  key: string;
  config: Record<string, unknown>;
}

export interface ValidationRecipePlan {
  recipe_id: string | null;
  commands: unknown;
  required_checks: unknown;
  artifact_expectations: unknown;
  timeout_seconds: number | null;
  profile_test_commands: unknown;
  profile_build_commands: unknown;
  forbidden_paths: unknown;
  missing_recipe_refs?: string[];
}

export interface VerificationInput {
  run: RunRecord;
  sandbox_cwd: string | null;
  base_commit_sha: string | null;
  output_json: unknown;
  materialization_items: RunMaterializationItemSummary[];
  /**
   * ADR 0016 P2: the run's resolved `HostExecutionPort` kind. Omitted (or
   * `"server"`) preserves today's behavior exactly; a future `"remote"` run
   * short-circuits `file_exists` rather than `stat`-ing a path that has no
   * meaning on this machine.
   */
  host_kind?: "server" | "remote";
}

export interface VerificationEnginePort {
  verify(
    input: VerificationInput,
    phase?: "all" | "pre_materialization" | "post_materialization",
  ): Promise<VerificationResultRecord[]>;
}

export interface VerificationSummary {
  declared: boolean;
  status: "passed" | "failed" | "incomplete" | "not_required";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  results: Array<{
    verifier_type: string;
    status: VerificationStatus;
    summary: string | null;
  }>;
}

export interface EvaluationVerificationResult {
  status: VerificationStatus;
  score: number;
  total: number;
  passed: number;
  failed: number;
  checks: Array<{
    type: string;
    status: VerificationStatus;
    summary: string;
    details: Record<string, unknown>;
  }>;
}
