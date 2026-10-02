import type { Proposal } from '../../types/api'

export type ProposalTypeFilter = '' | 'memory' | 'knowledge' | 'code_patch' | 'follow_up_task'

export const TYPE_FILTERS: { value: ProposalTypeFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'memory', label: 'Memory' },
  { value: 'knowledge', label: 'Knowledge' },
  { value: 'code_patch', label: 'Code' },
  { value: 'follow_up_task', label: 'Tasks' },
]

const KNOWLEDGE_PROPOSAL_TYPES = [
  'knowledge_create',
  'knowledge_update',
  'knowledge_archive',
  'claim_create',
  'claim_update',
  'claim_archive',
  'object_relation_create',
  'object_relation_delete',
  'claim_candidate_packet',
  'retrieval_maintenance_packet',
  'retrieval_diagnostics_packet',
]

export function apiTypesForFilter(type: string): (string | undefined)[] {
  if (!type) return [undefined]
  if (type === 'memory') return ['memory_create', 'memory_update', 'memory_archive']
  if (type === 'knowledge') return KNOWLEDGE_PROPOSAL_TYPES
  return [type]
}

export function proposalMatchesTypeFilter(p: Pick<Proposal, 'proposal_type'>, type: string): boolean {
  if (!type) return true
  if (type === 'memory') return p.proposal_type.startsWith('memory_')
  if (type === 'knowledge') {
    return KNOWLEDGE_PROPOSAL_TYPES.includes(p.proposal_type)
  }
  return p.proposal_type === type
}
