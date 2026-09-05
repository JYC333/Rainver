export const SETTINGS_KEYS = {
  acpAgents: "acp_agents.enabled",
  acpRegistryCache: "acp_agents.registry_cache",
  assistantDefault: "agent.default_assistant.settings",
  customSourceInstanceRunner: "source.custom_source.runner",
  customSourceSpacePolicy: "source.custom_source.space_policy",
  instanceOperations: "system.instance_operations",
  dailyCaptureReport: "daily_capture_report.settings",
  retrievalSpace: "retrieval.space.settings",
  runtimeContextCliEgressGeneration: "runtime_context.cli_egress_generation",
  runBudgetSpace: "runs.budget.space",
} as const;

export type SettingsKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS];
