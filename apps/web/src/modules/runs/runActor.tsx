import { Badge } from '../../components/ui/badge'
import type { Run } from '../../types/api'

/**
 * Who or what ran it. A `provider_task` Run is a bounded Server-side model
 * call — research ad-hoc analysis, notebook chat, a daily report — and has no
 * Agent by construction, so the absent name is not a missing one.
 *
 * Shared by the Runs list and the Run detail page: both have to say the same
 * thing about a Run with no Agent.
 */
export function runActorLabel(r: Run, agentName: string | null): string {
  if (agentName) return agentName
  if (r.execution_kind === 'provider_task') {
    return r.capability_id ? `Bounded provider task · ${r.capability_id}` : 'Bounded provider task'
  }
  return 'Agent unavailable'
}

/** The one badge that marks a Run as a bounded provider task rather than an Agent Run. */
export function ProviderTaskBadge({ run }: { run: Run }) {
  if (run.execution_kind !== 'provider_task') return null
  return <Badge variant="outline">provider task</Badge>
}
