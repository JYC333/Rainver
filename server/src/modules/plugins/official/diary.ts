import type { OfficialPluginDescriptor } from "@rainver/protocol";

export const DIARY_PLUGIN_ID = "diary";
export const DIARY_PLUGIN_VERSION = "0.1.0";

/**
 * diary — official optional module descriptor.
 *
 * This descriptor is pure metadata for the official plugin control plane.
 * Runtime behavior lives in the package under `plugins/official/diary/` and is
 * loaded from the compiled official plugin artifact at server startup.
 * Memory/context extraction remains opt-in and must go through proposal/sources
 * boundaries; normal diary editing writes the plugin-owned diary tables
 * directly.
 */
export const diaryDescriptor: OfficialPluginDescriptor = {
  id: DIARY_PLUGIN_ID,
  name: "Diary",
  description:
    "A personal diary that shows entries from the same day across multiple years. Supports AI reflection, daily reminders, and opt-in memory proposals.",
  version: DIARY_PLUGIN_VERSION,
  category: "personal",
  default_enabled: false,
  default_visible: true,
  scope: "user",
  lifecycle_status: "available",
  frontend_entries: [
    {
      module_id: "diary",
      label: "Diary",
      path: "/diary",
      icon: "book",
      section: "capture",
      group: "daily",
    },
  ],
  backend_feature_ids: ["diary_entries", "diary_reflections"],
  permissions: {
    creates_activity: false,
    can_propose_memory: true,
    can_contribute_context: "opt_in",
    uses_ai: true,
    uses_scheduler: true,
  },
  settings_defaults: {
    daily_reminder_enabled: false,
    ai_reflection_enabled: false,
    memory_proposal_enabled: false,
    include_in_context: false,
    default_visibility: "private",
  },
};
