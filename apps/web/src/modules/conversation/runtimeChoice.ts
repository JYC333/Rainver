import type { ConversationRuntimeChoice } from '@rainver/protocol'

/** Read projections carry server state; only these four fields are command input. */
export function runtimeChoice(runtime: ConversationRuntimeChoice): ConversationRuntimeChoice {
  return {
    agent_id: runtime.agent_id,
    runtime_profile_id: runtime.runtime_profile_id,
    runtime_key: runtime.runtime_key,
    runtime_installation: runtime.runtime_installation,
  }
}
