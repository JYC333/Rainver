export type ProjectPrimaryMode = "inquiry" | "decision" | "delivery" | "operations" | "learning";

// A Project Template is a creation-time defaults/setup-recommendation
// bundle, not a permanent Project type or feature gate. Applying a Template
// never enables or disables a Project Area — all installed Areas are always
// reachable. See project-model-clean-cutover-plan.md, "Project Template".
export interface ProjectTemplateDescriptor {
  key: string;
  name: string;
  description: string;
  sections: string[];
  extraction_profile_key: string | null;
  graph_lens_id: string | null;
  initial_primary_mode: ProjectPrimaryMode;
  starter_workflow_template_keys: string[];
}
