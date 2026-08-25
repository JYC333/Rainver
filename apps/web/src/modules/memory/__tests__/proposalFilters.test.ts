// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { apiTypesForFilter, proposalMatchesTypeFilter } from '../proposalFilters'

describe('proposal type filters', () => {
  it('includes maintenance packets and relation proposals in the Knowledge API filter', () => {
    expect(apiTypesForFilter('knowledge')).toEqual([
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
    ])
  })

  it('matches claim and retrieval packets under the Knowledge view', () => {
    expect(proposalMatchesTypeFilter({ proposal_type: 'retrieval_maintenance_packet' }, 'knowledge')).toBe(true)
    expect(proposalMatchesTypeFilter({ proposal_type: 'claim_candidate_packet' }, 'knowledge')).toBe(true)
    expect(proposalMatchesTypeFilter({ proposal_type: 'object_relation_create' }, 'knowledge')).toBe(true)
    expect(proposalMatchesTypeFilter({ proposal_type: 'memory_create' }, 'knowledge')).toBe(false)
  })
})
