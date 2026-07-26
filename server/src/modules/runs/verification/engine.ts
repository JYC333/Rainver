import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, isAbsolute, resolve } from "node:path";
import type { RunMaterializationItemSummary } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import { getDbPool } from "../../../db/pool";
import type { RunRecord } from "../repository";
import {
  VERIFICATION_ENGINE_VERSION,
  type ValidationRecipePlan,
  type VerificationDeclaration,
  type VerificationInput,
  type VerificationResultRecord,
  type VerificationStatus,
  type VerificationSummary,
  type VerifierType,
  type EvaluationVerificationResult,
} from "./types";
import { PgVerificationRepository, type VerificationPlanReader } from "./repository";
import type { Queryable } from "../runRepositoryTypes";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_TIMEOUT_SECONDS = 300;
const MAX_COMMAND_OUTPUT_BYTES = 8_000;
const KNOWN_VERIFIER_TYPES = new Set<string>([
  "command",
  "test",
  "lint",
  "typecheck",
  "file_exists",
  "file_changed",
  "diff_scope",
  "artifact_exists",
  "artifact_schema",
  "output_schema",
  "proposal_created",
  "no_forbidden_change",
  "recipe_ref",
  "manual_review",
  "model_judge",
]);
const POST_MATERIALIZATION_VERIFIER_TYPES = new Set([
  "artifact_exists",
  "proposal_created",
]);

interface RawVerificationResult {
  verifier_type: string;
  key: string;
  status: VerificationStatus;
  summary: string;
  evidence_refs_json: Record<string, unknown>;
  details_json: Record<string, unknown>;
  started_at: string;
  completed_at: string;
}

interface ChangedFiles {
  paths: string[];
  error: string | null;
}

export class PgVerificationEngine {
  private readonly planReader: VerificationPlanReader;
  private readonly resultRepository: PgVerificationRepository;

  constructor(db: Queryable, planReader: VerificationPlanReader = new PgVerificationRepository(db)) {
    this.planReader = planReader;
    this.resultRepository = planReader instanceof PgVerificationRepository
      ? planReader
      : new PgVerificationRepository(db);
  }

  static fromConfig(config: ServerConfig): PgVerificationEngine {
    if (!config.databaseUrl) throw new Error("Verification engine requires SERVER_DATABASE_URL");
    return new PgVerificationEngine(getDbPool(config.databaseUrl));
  }

  async verify(
    input: VerificationInput,
    phase: "all" | "pre_materialization" | "post_materialization" = "all",
  ): Promise<VerificationResultRecord[]> {
    const plan = await this.planReader.getPlan(input.run);
    const declarations = buildVerificationDeclarations(
      input.run,
      plan,
      input.materialization_items,
    ).filter((declaration) => {
      const postMaterialization =
        POST_MATERIALIZATION_VERIFIER_TYPES.has(declaration.verifier_type)
        || declaration.key.startsWith("code_patch:");
      if (phase === "all") return true;
      return phase === "post_materialization"
        ? postMaterialization
        : !postMaterialization;
    });
    if (declarations.length === 0) return [];

    const changed = await changedFiles(input.sandbox_cwd, input.base_commit_sha);
    const rawResults: RawVerificationResult[] = [];
    for (const declaration of declarations) {
      rawResults.push(await evaluateDeclaration(input, declaration, changed));
    }
    const results = aggregateResults(rawResults);
    return this.resultRepository.upsertResults(input.run.space_id, input.run.id, results);
  }
}

export function buildVerificationDeclarations(
  run: Pick<RunRecord, "contract_snapshot_json" | "output_json">,
  plan: ValidationRecipePlan,
  materializationItems: RunMaterializationItemSummary[],
): VerificationDeclaration[] {
  const declarations: VerificationDeclaration[] = [];
  const contract = recordValue(run.contract_snapshot_json);
  const acceptance = recordValue(contract.acceptance_criteria_json);
  const routeHints = recordValue(contract.route_hints_json);

  addCheckList(declarations, contract.acceptance_criteria_json);
  addCheckList(declarations, acceptance.checks ?? acceptance.verifiers ?? acceptance.validation);
  addCheckList(declarations, routeHints.verification ?? routeHints.verifications);
  addCommandList(declarations, plan.commands, undefined, plan.timeout_seconds);

  if (!hasExecutableCommandDeclarations(declarations)) {
    addCommandList(declarations, plan.profile_test_commands, "test");
    addCommandList(declarations, plan.profile_build_commands, "command");
  }
  addRequiredCheckList(declarations, plan.required_checks);
  addCheckList(declarations, plan.artifact_expectations);
  addCheckList(declarations, runRequiredOutputs(contract.required_outputs_json));
  for (const recipeRef of plan.missing_recipe_refs ?? []) {
    addDeclaration(declarations, "recipe_ref", `recipe_ref:${recipeRef}`, {
      recipe_ref: recipeRef,
    });
  }

  const hasCollectedPatch = materializationItems.some(
    (item) => item.kind === "code_patch" && (item.status === "succeeded" || item.status === "warning"),
  );
  if (hasCollectedPatch) {
    addDeclaration(declarations, "file_changed", "code_patch:file_changed", { path: "*" });
    addDeclaration(declarations, "no_forbidden_change", "code_patch:no_forbidden_change", {
      forbidden_paths: plan.forbidden_paths,
    });
  }

  return dedupeDeclarations(declarations);
}

export function hasDeclaredVerificationChecks(
  run: Pick<RunRecord, "contract_snapshot_json" | "output_json">,
): boolean {
  const contract = recordValue(run.contract_snapshot_json);
  const acceptance = recordValue(contract.acceptance_criteria_json);
  const routeHints = recordValue(contract.route_hints_json);
  return hasCheckList(contract.acceptance_criteria_json)
    || hasCheckList(acceptance.checks ?? acceptance.verifiers ?? acceptance.validation)
    || hasCheckList(routeHints.verification ?? routeHints.verifications)
    || stringArray(routeHints.verification_recipe_refs).length > 0
    || hasCheckList(runRequiredOutputs(contract.required_outputs_json))
    || hasCollectedPatchInOutput(run.output_json);
}

export function summarizeVerificationResults(
  results: Array<Pick<VerificationResultRecord, "verifier_type" | "status" | "summary">>,
): VerificationSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const errors = results.filter((result) => result.status === "error").length;
  const declared = results.length > 0;
  return {
    declared,
    status: !declared
      ? "not_required"
      : failed > 0 || errors > 0
        ? "failed"
        : skipped > 0
          ? "incomplete"
          : "passed",
    total: results.length,
    passed,
    failed,
    skipped,
    errors,
    results: results.map((result) => ({
      verifier_type: result.verifier_type,
      status: result.status,
      summary: result.summary,
    })),
  };
}

/**
 * Runs the output-only subset of verification_engine.v1 against an evaluation
 * fixture. Evaluation jobs intentionally do not accept arbitrary shell or
 * connector execution; they reuse the same schema verifier as run
 * finalization and keep the fixture side read-only/mock.
 */
export function verifyEvaluationOutput(outputJson: unknown, recipe: Record<string, unknown>): EvaluationVerificationResult {
  const checks = Array.isArray(recipe.checks) ? recipe.checks : [];
  const results = checks.map((check, index) => {
    const declaration = recordValue(check);
    const type = stringValue(declaration.type ?? declaration.verifier_type) ?? "";
    if (type === "output_schema") {
      const result = schemaResult(outputJson, declaration.schema, "Output schema passed.", "Output schema failed.");
      return {
        type,
        status: result.status,
        summary: result.summary ?? `output_schema check ${index + 1} completed.`,
        details: recordValue(result.details_json),
      };
    }
    if (type === "exact_json") {
      const expected = declaration.value;
      const passed = stableJson(outputJson) === stableJson(expected);
      return {
        type,
        status: passed ? "passed" as const : "failed" as const,
        summary: passed ? "Output matched the exact JSON expectation." : "Output differed from the exact JSON expectation.",
        details: { expected },
      };
    }
    return {
      type: type || "unknown",
      status: "error" as const,
      summary: type ? `Evaluation verifier '${type}' is not available for fixture execution.` : "Evaluation verifier type is required.",
      details: { implementation_status: "unsupported_in_fixture_executor" },
    };
  });
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const total = results.length;
  return {
    status: total === 0
      ? "error"
      : results.some((result) => result.status === "error")
        ? "error"
        : failed > 0
          ? "failed"
          : "passed",
    score: total === 0 ? 0 : passed / total,
    total,
    passed,
    failed,
    checks: results,
  };
}

function addCheckList(declarations: VerificationDeclaration[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addCheck(declarations, item);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.checks)) {
      addCheckList(declarations, record.checks);
    } else if (record.verifier_type || record.type || record.kind) {
      addCheck(declarations, record);
    }
  }
}

function addRequiredCheckList(declarations: VerificationDeclaration[], value: unknown): void {
  if (!Array.isArray(value)) {
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const type of ["command", "test", "lint", "typecheck", "file_exists", "file_changed", "diff_scope", "artifact_exists", "artifact_schema", "output_schema", "proposal_created", "no_forbidden_change"]) {
        if (record[type] === true) {
          addCheck(declarations, { type });
        }
      }
    }
    addCheckList(declarations, value);
    return;
  }
  for (const item of value) {
    const type = typeof item === "string"
      ? item.split(":", 1)[0]
      : item && typeof item === "object" && !Array.isArray(item)
        ? stringValue((item as Record<string, unknown>).verifier_type)
          ?? stringValue((item as Record<string, unknown>).type)
          ?? stringValue((item as Record<string, unknown>).kind)
        : null;
    if (type && ["command", "test", "lint", "typecheck"].includes(type)
      && declarations.some((declaration) => declaration.verifier_type === type && declaration.config.command !== undefined)) {
      continue;
    }
    addCheck(declarations, item);
  }
}

function addCheck(declarations: VerificationDeclaration[], value: unknown): void {
  if (typeof value === "string") {
    const [type, ...rest] = value.split(":");
    if (KNOWN_VERIFIER_TYPES.has(type)) {
      addDeclaration(declarations, type, `check:${value}`, rest.length > 0 ? { value: rest.join(":") } : {});
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const type = stringValue(record.verifier_type) ?? stringValue(record.type) ?? stringValue(record.kind);
  if (!type) return;
  const config = { ...record };
  delete config.verifier_type;
  delete config.type;
  delete config.kind;
  const key = stringValue(record.id) ?? stringValue(record.name) ?? `check:${type}:${declarations.length}`;
  addDeclaration(declarations, type, key, config);
}

function addCommandList(
  declarations: VerificationDeclaration[],
  value: unknown,
  defaultType?: string,
  defaultTimeoutSeconds?: number | null,
): void {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      addCommandList(declarations, [value], defaultType, defaultTimeoutSeconds);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.commands)) addCommandList(declarations, record.commands, defaultType, defaultTimeoutSeconds);
      for (const type of ["command", "test", "lint", "typecheck"]) {
        if (record[type] !== undefined) addCommandList(declarations, record[type], type, defaultTimeoutSeconds);
      }
    }
    return;
  }
  for (const item of value) {
    if (typeof item === "string" || Array.isArray(item)) {
      const type = defaultType ?? inferredCommandType(item);
      const config: Record<string, unknown> = {
        command: item,
      };
      if (defaultTimeoutSeconds !== null && defaultTimeoutSeconds !== undefined) {
        config.timeout_seconds = defaultTimeoutSeconds;
      }
      addDeclaration(declarations, type, `command:${declarations.length}`, config);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const command = record.command ?? record.argv ?? record.value;
    if (command === undefined) continue;
    const type = stringValue(record.verifier_type)
      ?? stringValue(record.type)
      ?? defaultType
      ?? inferredCommandType(command);
    const config: Record<string, unknown> = { ...record, command };
    if (config.timeout_seconds === undefined && defaultTimeoutSeconds !== null && defaultTimeoutSeconds !== undefined) {
      config.timeout_seconds = defaultTimeoutSeconds;
    }
    delete config.verifier_type;
    delete config.type;
    addDeclaration(declarations, type, `command:${declarations.length}`, config);
  }
}

function addDeclaration(
  declarations: VerificationDeclaration[],
  type: string,
  key: string,
  config: Record<string, unknown>,
): void {
  declarations.push({ verifier_type: type as VerifierType, key, config });
}

function runRequiredOutputs(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item !== "string") return item;
    if (item.startsWith("file:")) return { type: "file_exists", path: item.slice(5) };
    if (item.startsWith("proposal:")) return { type: "proposal_created", proposal_type: item.slice(9) };
    return { type: "artifact_exists", title: item };
  });
}

function hasExecutableCommandDeclarations(declarations: VerificationDeclaration[]): boolean {
  return declarations.some((declaration) =>
    ["command", "test", "lint", "typecheck"].includes(declaration.verifier_type)
    && declaration.config.command !== undefined,
  );
}

function inferredCommandType(command: unknown): string {
  const text = Array.isArray(command) ? command.join(" ").toLowerCase() : String(command).toLowerCase();
  if (/type[-_ ]?check|tsc/.test(text)) return "typecheck";
  if (/lint|eslint|stylelint/.test(text)) return "lint";
  if (/test|vitest|jest|pytest/.test(text)) return "test";
  return "command";
}

function hasCheckList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.checks) ? record.checks.length > 0 : Boolean(record.type || record.verifier_type);
}

function hasCollectedPatchInOutput(value: unknown): boolean {
  const output = recordValue(value);
  return arrayValue(output.materialization).some((item) => {
    const record = recordValue(item);
    return record.kind === "code_patch" && ["succeeded", "warning"].includes(String(record.status));
  });
}

function dedupeDeclarations(declarations: VerificationDeclaration[]): VerificationDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((declaration) => {
    const key = `${declaration.verifier_type}:${JSON.stringify(declaration.config)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function evaluateDeclaration(
  input: VerificationInput,
  declaration: VerificationDeclaration,
  changed: ChangedFiles,
): Promise<RawVerificationResult> {
  const startedAt = new Date().toISOString();
  const type = declaration.verifier_type;
  let result: Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key">;
  try {
    result = await evaluateByType(input, declaration, changed);
  } catch (error) {
    result = {
      status: "error",
      summary: error instanceof Error ? error.message : "Verifier failed unexpectedly.",
      evidence_refs_json: { source: "verification_engine", verifier_key: declaration.key },
      details_json: {},
    };
  }
  return {
    verifier_type: type,
    key: declaration.key,
    ...result,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
  };
}

async function evaluateByType(
  input: VerificationInput,
  declaration: VerificationDeclaration,
  changed: ChangedFiles,
): Promise<Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key">> {
  const type = declaration.verifier_type;
  if (["command", "test", "lint", "typecheck"].includes(type)) {
    return evaluateCommand(input.sandbox_cwd, declaration);
  }
  if (type === "file_exists") return evaluateFileExistsAsync(input.sandbox_cwd, declaration.config);
  if (type === "file_changed") return evaluateFileChanged(changed, declaration.config);
  if (type === "diff_scope") return evaluateDiffScope(changed, declaration.config);
  if (type === "no_forbidden_change") return evaluateNoForbiddenChange(changed, declaration.config);
  if (type === "artifact_exists") return evaluateArtifactExists(input.materialization_items, declaration.config);
  if (type === "artifact_schema") return evaluateArtifactSchema(input.output_json, declaration.config);
  if (type === "output_schema") return evaluateOutputSchema(input.output_json, declaration.config);
  if (type === "proposal_created") return evaluateProposalCreated(input.materialization_items, declaration.config);
  if (type === "manual_review" || type === "model_judge") {
    return {
      status: "skipped",
      summary: `${type} is declared but not implemented in verification_engine.v1.`,
      evidence_refs_json: { source: "verification_engine", verifier_type: type },
      details_json: { implementation_status: "deferred" },
    };
  }
  if (type === "recipe_ref") {
    return {
      status: "error",
      summary: `Verification recipe '${stringValue(declaration.config.recipe_ref) ?? "unknown"}' could not be resolved in this space.`,
      evidence_refs_json: { source: "validation_recipe", recipe_ref: declaration.config.recipe_ref },
      details_json: { implementation_status: "recipe_not_found" },
    };
  }
  return {
    status: "error",
    summary: `Unsupported verifier type '${type}'.`,
    evidence_refs_json: { source: "verification_engine", verifier_type: type },
    details_json: {},
  };
}

async function evaluateCommand(
  sandboxCwd: string | null,
  declaration: VerificationDeclaration,
): Promise<Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key">> {
  if (!sandboxCwd) return unavailable("A sandbox is required for command verification.");
  const command = commandArgv(declaration.config.command);
  if (!command || command.length === 0) return unavailable("Validation command is missing.");
  if (command.some((part) => /[;&|<>]/.test(part))) {
    return unavailable("Validation command contains unsupported shell syntax.");
  }
  const requestedTimeout = numberValue(declaration.config.timeout_seconds);
  const timeout = Math.min(
    MAX_COMMAND_TIMEOUT_SECONDS,
    Math.max(1, requestedTimeout ?? MAX_COMMAND_TIMEOUT_SECONDS),
  ) * 1_000;
  const started = Date.now();
  const verificationHome = await mkdtemp(resolve(sandboxCwd, ".verification-home-"));
  try {
    await execFileAsync(command[0]!, command.slice(1), {
      cwd: sandboxCwd,
      shell: false,
      timeout,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: verificationHome,
        CI: "1",
      },
    });
    return {
      status: "passed",
      summary: `${declaration.verifier_type} command passed.`,
      evidence_refs_json: {
        source: "validation_recipe",
        command: command[0],
        verifier_type: declaration.verifier_type,
      },
      details_json: { exit_code: 0, duration_ms: Date.now() - started },
    };
  } catch (error) {
    const failure = error as { code?: string | number; signal?: string; killed?: boolean };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    return {
      status: "failed",
      summary: `${declaration.verifier_type} command failed.`,
      evidence_refs_json: {
        source: "validation_recipe",
        command: command[0],
        verifier_type: declaration.verifier_type,
      },
      details_json: {
        exit_code: exitCode,
        signal: failure.signal ?? null,
        timed_out: failure.killed === true,
        duration_ms: Date.now() - started,
      },
    };
  } finally {
    await rm(verificationHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function evaluateFileExistsAsync(
  sandboxCwd: string | null,
  config: Record<string, unknown>,
): Promise<Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key">> {
  const path = stringValue(config.path) ?? stringValue(config.value);
  if (!sandboxCwd) return unavailable("A sandbox is required for file_exists verification.");
  if (!path || !safeRelativePath(path)) return unavailable("file_exists requires a safe relative path.");
  try {
    const info = await stat(resolve(sandboxCwd, path));
    return {
      status: info.isFile() || info.isDirectory() ? "passed" : "failed",
      summary: info.isFile() || info.isDirectory() ? `Required path '${path}' exists.` : `Required path '${path}' is not usable.`,
      evidence_refs_json: { source: "sandbox", path },
      details_json: { kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" },
    };
  } catch {
    return {
      status: "failed",
      summary: `Required path '${path}' does not exist.`,
      evidence_refs_json: { source: "sandbox", path },
      details_json: {},
    };
  }
}

function evaluateFileChanged(
  changed: ChangedFiles,
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  if (changed.error) return unavailable(changed.error);
  const requested = stringValue(config.path);
  const matched = changed.paths.filter((path) => !requested || requested === "*" || matchesPath(path, requested));
  return {
    status: matched.length > 0 ? "passed" : "failed",
    summary: matched.length > 0 ? "Expected file change was detected." : "Expected file change was not detected.",
    evidence_refs_json: { source: "git", changed_paths: changed.paths, requested_path: requested },
    details_json: { matched_paths: matched },
  };
}

function evaluateDiffScope(
  changed: ChangedFiles,
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  if (changed.error) return unavailable(changed.error);
  const allowed = stringArray(config.allowed_paths ?? config.paths);
  if (allowed.length === 0) return unavailable("diff_scope requires allowed_paths.");
  const outside = changed.paths.filter((path) => !allowed.some((pattern) => matchesPath(path, pattern)));
  return {
    status: outside.length === 0 ? "passed" : "failed",
    summary: outside.length === 0 ? "All changes are within the declared diff scope." : "Changes escaped the declared diff scope.",
    evidence_refs_json: { source: "git", allowed_paths: allowed, changed_paths: changed.paths },
    details_json: { outside_scope: outside },
  };
}

function evaluateNoForbiddenChange(
  changed: ChangedFiles,
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  if (changed.error) return unavailable(changed.error);
  const forbidden = stringArray(config.forbidden_paths);
  const violations = changed.paths.filter((path) => forbidden.some((pattern) => matchesPath(path, pattern)));
  return {
    status: violations.length === 0 ? "passed" : "failed",
    summary: violations.length === 0 ? "No forbidden paths were changed." : "A forbidden path was changed.",
    evidence_refs_json: { source: "git", forbidden_paths: forbidden, changed_paths: changed.paths },
    details_json: { violations },
  };
}

function evaluateArtifactExists(
  items: RunMaterializationItemSummary[],
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  const expectedTitle = stringValue(config.title) ?? stringValue(config.name);
  const expectedType = stringValue(config.artifact_type) ?? stringValue(config.artifactType);
  const candidates = items.filter((item) => item.kind === "artifact" && item.status === "succeeded");
  const matched = candidates.filter((item) => {
    const metadata = recordValue(item.metadata_json);
    return (!expectedTitle || stringValue(metadata.title) === expectedTitle)
      && (!expectedType || stringValue(metadata.artifact_type) === expectedType);
  });
  return {
    status: matched.length > 0 ? "passed" : "failed",
    summary: matched.length > 0 ? "Required artifact was materialized." : "Required artifact was not materialized.",
    evidence_refs_json: { source: "run_materialization", artifact_ids: matched.map((item) => item.artifact_id).filter(Boolean) },
    details_json: { expected_title: expectedTitle, expected_type: expectedType, candidate_count: candidates.length },
  };
}

function evaluateProposalCreated(
  items: RunMaterializationItemSummary[],
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  const expectedType = stringValue(config.proposal_type) ?? stringValue(config.type);
  const candidates = items.filter(
    (item) => ["proposal", "code_patch"].includes(item.kind) && item.status === "succeeded" && Boolean(item.proposal_id),
  );
  const matched = candidates.filter((item) => {
    const metadata = recordValue(item.metadata_json);
    return !expectedType || item.kind === "code_patch" || stringValue(metadata.proposal_type) === expectedType;
  });
  return {
    status: matched.length > 0 ? "passed" : "failed",
    summary: matched.length > 0 ? "Required proposal was created." : "Required proposal was not created.",
    evidence_refs_json: { source: "run_materialization", proposal_ids: matched.map((item) => item.proposal_id).filter(Boolean) },
    details_json: { expected_type: expectedType, candidate_count: candidates.length },
  };
}

function evaluateArtifactSchema(
  outputJson: unknown,
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  const artifacts = arrayValue(recordValue(outputJson).artifacts);
  const index = numberValue(config.index);
  const candidate = index === null ? artifacts[0] : artifacts[index];
  if (!candidate) return failed("Expected output artifact was not present.");
  const content = stringValue(recordValue(candidate).content);
  if (content === null) return unavailable("Artifact schema verification requires inline artifact content.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return failed("Artifact content is not valid JSON.");
  }
  return schemaResult(parsed, config.schema, "Artifact schema passed.", "Artifact schema failed.");
}

function evaluateOutputSchema(
  outputJson: unknown,
  config: Record<string, unknown>,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  return schemaResult(outputJson, config.schema, "Output schema passed.", "Output schema failed.");
}

function schemaResult(
  value: unknown,
  schema: unknown,
  passedSummary: string,
  failedSummary: string,
): Omit<RawVerificationResult, "started_at" | "completed_at" | "verifier_type" | "key"> {
  if (!schema || typeof schema !== "object") return unavailable("Schema verifier requires a JSON schema object.");
  const errors: string[] = [];
  validateSchema(value, schema as Record<string, unknown>, "$", errors);
  return {
    status: errors.length === 0 ? "passed" : "failed",
    summary: errors.length === 0 ? passedSummary : failedSummary,
    evidence_refs_json: { source: "json_schema" },
    details_json: { error_count: errors.length, error_codes: errors.slice(0, 20) },
  };
}

function validateSchema(value: unknown, schema: Record<string, unknown>, path: string, errors: string[]): void {
  const type = stringValue(schema.type);
  if (type && !matchesJsonType(value, type)) errors.push(`${path}:type:${type}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path}:enum`);
  }
  if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}:const`);
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) errors.push(`${path}:minLength`);
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, index) => validateSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const required of stringArray(schema.required)) {
      if (!Object.hasOwn(object, required)) errors.push(`${path}.${required}:required`);
    }
    const properties = recordValue(schema.properties);
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(object, key) && childSchema && typeof childSchema === "object") {
        validateSchema(object[key], childSchema as Record<string, unknown>, `${path}.${key}`, errors);
      }
    }
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

async function changedFiles(sandboxCwd: string | null, baseCommitSha: string | null): Promise<ChangedFiles> {
  if (!sandboxCwd) return { paths: [], error: "A sandbox is required for git verification." };
  const base = baseCommitSha && /^[0-9a-f]{7,64}$/i.test(baseCommitSha) ? baseCommitSha : "HEAD";
  try {
    const diff = await execFileAsync("git", ["diff", "--name-only", base], {
      cwd: sandboxCwd,
      shell: false,
      timeout: 30_000,
      maxBuffer: 64_000,
      windowsHide: true,
    });
    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: sandboxCwd,
      shell: false,
      timeout: 30_000,
      maxBuffer: 64_000,
      windowsHide: true,
    });
    const paths = new Set<string>();
    for (const value of String(diff.stdout).split(/\r?\n/)) if (value.trim()) paths.add(normalizeGitPath(value.trim()));
    for (const value of String(status.stdout).split(/\r?\n/)) {
      const path = value.slice(3).trim();
      if (path) paths.add(normalizeGitPath(path));
    }
    return { paths: [...paths].sort(), error: null };
  } catch {
    return { paths: [], error: "Git change inspection failed." };
  }
}

function aggregateResults(results: RawVerificationResult[]) {
  const groups = new Map<string, RawVerificationResult[]>();
  for (const result of results) groups.set(result.verifier_type, [...(groups.get(result.verifier_type) ?? []), result]);
  return [...groups.entries()].map(([verifierType, group]) => {
    const status: VerificationStatus = group.some((result) => result.status === "error")
      ? "error"
      : group.some((result) => result.status === "failed")
        ? "failed"
        : group.some((result) => result.status === "skipped")
          ? "skipped"
          : "passed";
    const failed = group.filter((result) => result.status !== "passed").length;
    return {
      verifier_type: verifierType,
      verifier_version: VERIFICATION_ENGINE_VERSION,
      status,
      summary: group.length === 1
        ? group[0]!.summary
        : `${group.length - failed}/${group.length} ${verifierType} checks passed.`,
      evidence_refs_json: {
        checks: group.map((result) => ({
          key: result.key,
          status: result.status,
          evidence: result.evidence_refs_json,
        })),
      },
      details_json: {
        checks: group.map((result) => ({ key: result.key, status: result.status, details: result.details_json })),
      },
      started_at: group[0]!.started_at,
      completed_at: group[group.length - 1]!.completed_at,
    };
  });
}

function unavailable(summary: string) {
  return {
    status: "error" as const,
    summary,
    evidence_refs_json: { source: "verification_engine" },
    details_json: { availability: "missing_prerequisite" },
  };
}

function failed(summary: string) {
  return {
    status: "failed" as const,
    summary,
    evidence_refs_json: { source: "verification_engine" },
    details_json: {},
  };
}

function commandArgv(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string" && part.length > 0);
    return parts.length === value.length ? parts : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parts: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  return parts.length > 0 ? parts : null;
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function matchesPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizeGitPath(path);
  const normalizedPattern = normalizeGitPath(pattern);
  if (normalizedPattern === "*") return true;
  const regex = new RegExp(`^${escapeRegex(normalizedPattern).replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*").replaceAll("\\?", "[^/]")}$`);
  return regex.test(normalizedPath) || normalizedPath === normalizedPattern || basename(normalizedPath) === normalizedPattern;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
