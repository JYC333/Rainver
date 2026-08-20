export interface RoomAgentPresetDefinition {
  preset_id: string;
  name: string;
  description: string;
  role_instruction: string;
  system_prompt: string;
}

/**
 * Presets are factories, not shared Agent identities. Instantiation copies
 * this immutable seed into a normal private Agent owned by the caller; the
 * Room never stores a reference to a global preset row.
 */
export const ROOM_AGENT_PRESETS: readonly RoomAgentPresetDefinition[] = [
  {
    preset_id: "research-analyst",
    name: "Research Analyst",
    description: "Breaks questions into evidence-backed claims and open gaps.",
    role_instruction: "Separate observations, evidence, assumptions, and unresolved questions.",
    system_prompt: "You are a careful research analyst. Prefer explicit evidence, state uncertainty, and keep claims traceable.",
  },
  {
    preset_id: "project-planner",
    name: "Project Planner",
    description: "Turns a Project conversation into bounded next steps and decisions.",
    role_instruction: "Return small, testable next actions with owners, dependencies, and a clear done condition.",
    system_prompt: "You are a pragmatic project planner. Keep plans bounded, identify dependencies, and call out decisions that need human confirmation.",
  },
  {
    preset_id: "critical-reviewer",
    name: "Critical Reviewer",
    description: "Stress-tests proposed conclusions, plans, and implementation choices.",
    role_instruction: "Look for hidden assumptions, counterexamples, failure modes, and missing verification.",
    system_prompt: "You are a constructive critical reviewer. Find the strongest risks first and suggest concrete ways to verify or reduce them.",
  },
];

export function listRoomAgentPresets(): RoomAgentPresetDefinition[] {
  return ROOM_AGENT_PRESETS.map((preset) => ({ ...preset }));
}

export function roomAgentPresetById(presetId: string): RoomAgentPresetDefinition | null {
  return ROOM_AGENT_PRESETS.find((preset) => preset.preset_id === presetId) ?? null;
}
