import { describe, it, expect } from 'vitest'
import { KNOWLEDGE_ITEM_KINDS, KNOWLEDGE_LINK_TYPES } from '../utils'

// These lock the frontend canonical Wiki vocabularies to the backend-accepted
// sets so a form can never offer a value the backend rejects with a 422.

describe('Knowledge canonical item kinds', () => {
  it('exposes exactly the canonical KnowledgeItem kinds', () => {
    expect([...KNOWLEDGE_ITEM_KINDS].sort()).toEqual(
      ['answer', 'concept', 'decision', 'lesson', 'procedure', 'question', 'summary'],
    )
  })

  it('drops the removed working-note item types', () => {
    for (const removed of ['knowledge', 'claim', 'idea', 'experience', 'reflection', 'source']) {
      expect(KNOWLEDGE_ITEM_KINDS).not.toContain(removed)
    }
  })
})

describe('Knowledge canonical relation types', () => {
  it('exposes exactly the canonical KnowledgeRelation types', () => {
    expect([...KNOWLEDGE_LINK_TYPES].sort()).toEqual(
      [
        'applies_to', 'contradicts', 'depends_on', 'derived_from', 'example_of',
        'explains', 'part_of', 'prerequisite_of', 'related_to', 'summarizes',
        'supports', 'updates',
      ],
    )
  })

  it('drops removed relation types', () => {
    for (const removed of ['related', 'answers']) {
      expect(KNOWLEDGE_LINK_TYPES).not.toContain(removed)
    }
  })
})
