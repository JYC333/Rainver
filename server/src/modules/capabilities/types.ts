export type CapabilitySourceKind = "builtin" | "imported_skill" | "generated" | "official";
export type CapabilityStatus =
  | "draft"
  | "proposed"
  | "testing"
  | "available"
  | "enabled"
  | "disabled"
  | "archived";
export type SkillSourceType = "github" | "registry" | "local_workspace" | "upload" | "builtin";
export type SkillRiskLevel = "low" | "medium" | "high" | "critical";
export type SkillPackageStatus =
  | "imported"
  | "reviewed"
  | "rejected"
  | "converted"
  | "archived"
  | "superseded";
export type RuntimeRenderMode = "render_skill" | "inline_prompt" | "native_executor" | "mcp_tool";

export interface CapabilityRuntimeBinding {
  id: string;
  capability_id: string;
  runtime_adapter_type: string;
  render_mode: RuntimeRenderMode;
  binding_json: Record<string, unknown>;
  enabled: boolean;
}

export interface CapabilityDefinition {
  id: string;
  namespace: string;
  name: string;
  description: string;
  version: string;
  source_kind: CapabilitySourceKind;
  input_schema_json: Record<string, unknown>;
  output_artifact_types: string[];
  permissions: Record<string, unknown>;
  supported_execution_modes: string[];
  default_runtime_bindings: CapabilityRuntimeBinding[];
  status: CapabilityStatus;
}

export interface CapabilityPackDescriptor {
  id: string;
  name: string;
  description: string;
  version: string;
  capability_ids: string[];
  artifact_types: string[];
  source_kind: CapabilitySourceKind;
  status: CapabilityStatus;
}

export interface SkillSource {
  id: string;
  source_type: SkillSourceType;
  url: string | null;
  repo: string | null;
  path: string | null;
  ref: string | null;
  commit_sha: string | null;
  content_hash: string;
  fetched_at: string;
  metadata_json: Record<string, unknown>;
}

export interface SkillPackage {
  id: string;
  source_id: string;
  package_name: string;
  version: string | null;
  license: string | null;
  raw_storage_ref: string | null;
  manifest_json: Record<string, unknown>;
  normalized_json: Record<string, unknown>;
  risk_level: SkillRiskLevel;
  status: SkillPackageStatus;
  created_at: string;
  updated_at: string;
}

export interface SkillPackageFilePreview {
  path: string;
  kind: string;
  content_hash?: string | null;
  content_type?: string | null;
  byte_length?: number | null;
  included: boolean;
  executable: boolean;
  risk_flags_json: Record<string, unknown>;
}

export interface SkillPackageFile extends SkillPackageFilePreview {
  id: string;
  skill_package_id: string;
  storage_ref: string | null;
  created_at: string;
}

export interface NormalizedSkillResource {
  path: string;
  kind: string;
  description?: string | null;
  content_hash?: string | null;
  content_type?: string | null;
  byte_length?: number | null;
}

export interface NormalizedSkill {
  spec_kind?: string;
  spec_version?: string | null;
  skill_root?: string | null;
  package_hash?: string | null;
  diagnostics?: string[];
  name: string;
  description: string;
  version: string;
  license: string | null;
  instructions_markdown: string;
  resources: NormalizedSkillResource[];
  requested_permissions: string[];
  execution_profile: Record<string, unknown>;
  vendor_extensions: Record<string, unknown>;
  trust_analysis: Record<string, unknown>;
}

export interface SkillRiskAnalysis {
  risk_level: SkillRiskLevel;
  warnings: string[];
  requested_permissions: string[];
  signals: string[];
}

export interface SkillImportPreview {
  source: Omit<SkillSource, "id" | "fetched_at">;
  normalized_skill: NormalizedSkill;
  package_root: string;
  package_hash: string;
  package_files: SkillPackageFilePreview[];
  risk_level: SkillRiskLevel;
  requested_permissions: string[];
  files_detected: string[];
  warnings: string[];
  persistable: boolean;
  raw_content: string;
}

export interface RuntimeRenderedFile {
  path: string;
  content: string;
}

export interface RuntimeRenderedSkill {
  runtime_adapter_type: string;
  render_mode: RuntimeRenderMode;
  root_path: string | null;
  files: RuntimeRenderedFile[];
  prompt_block: string | null;
}
