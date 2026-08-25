// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { currentPendingContextVersion } from '../currentPendingContextVersion'

describe('currentPendingContextVersion', () => {
  it('ignores pending versions older than the active published version', () => {
    expect(currentPendingContextVersion([
      { version: 'v4', status: 'published' },
      { version: 'v3', status: 'in_review' },
      { version: 'v2', status: 'draft' },
    ])).toBeNull()
  })

  it('restores a pending version only when it is newer than active', () => {
    const pending = { version: 'v5', status: 'in_review' as const }
    expect(currentPendingContextVersion([
      pending,
      { version: 'v4', status: 'published' },
    ])).toBe(pending)
  })

  it('selects a corrected draft newer than an in-review version', () => {
    const corrected = { version: 'v6', status: 'draft' as const }
    expect(currentPendingContextVersion([
      { version: 'v5', status: 'in_review' },
      corrected,
      { version: 'v4', status: 'published' },
    ])).toBe(corrected)
  })
})
