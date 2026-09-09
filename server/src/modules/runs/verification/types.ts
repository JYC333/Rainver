import type { LaunchWorkspace, RunMaterializationItemSummary } from "@rainver/protocol";
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

/**
 * Where a verifier's questions are asked: a workspace on an execution host,
 * named the way every other host request names one — a Host id plus a Location
 * or a managed container, never a path (B64).
 *
 * It replaces the `sandbox_cwd` this used to carry. That was a server path,
 * which only ever existed while the server spawned CLIs itself; now that every
 * CLI Run belongs to a daemon, there is no such path to hand a verifier, and
 * the same target works on the built-in host and a paired one alike — which is
 * what makes verification available on a paired host at all.
 */
export interface VerificationTarget {
  host_id: string;
  workspace_location_id?: string | null;
  workspace?: LaunchWorkspace;
}

export interface VerificationInput {
  run: RunRecord;
  execution_target: VerificationTarget | null;
  base_commit_sha: string | null;
  output_json: unknown;
  materialization_items: RunMaterializationItemSummary[];
  /** Which machine, for the record a verification result carries; it no longer decides how a verifier runs. */
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
