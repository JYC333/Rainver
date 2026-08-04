export const SETTINGS_KEYS = {
  assistantDefault: "agent.default_assistant.settings",
  customSourceInstanceRunner: "source.custom_source.runner",
  customSourceSpacePolicy: "source.custom_source.space_policy",
  dailyCaptureReport: "daily_capture_report.settings",
  retrievalSpace: "retrieval.space.settings",
  runBudgetSpace: "runs.budget.space",
} as const;

export type SettingsKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS];
