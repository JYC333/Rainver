import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../../../i18n'
import { proposalTitle } from '../proposalTitle'

// A promotion proposal is server data read by people in any language: its
// title is worded from the facts it records, not from the stored English.

const stored = 'Promote research.prompt v3 to project:project-1'
const parts = { kind: 'asset_version_promote' as const, asset_key: 'research.prompt', version: 3, target_scope_type: 'project', target_scope_id: 'project-1' }

afterEach(async () => { await i18n.changeLanguage('en') })

describe('proposalTitle', () => {
  it('words a promotion in the UI language and keeps the asset key as written', async () => {
    expect(proposalTitle(stored, parts)).toBe('Promote research.prompt v3 to project project-1')
    expect(proposalTitle(stored, { ...parts, target_scope_type: 'space', target_scope_id: null })).toBe('Promote research.prompt v3 to space')

    await i18n.changeLanguage('zh-CN')
    expect(proposalTitle(stored, parts)).toBe('将 research.prompt v3 推广到项目 project-1')
    expect(proposalTitle(stored, { ...parts, target_scope_type: 'space', target_scope_id: null })).toBe('将 research.prompt v3 推广到空间')
  })

  it('shows the stored title for a proposal without recorded facts', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(proposalTitle('记住会议时间', null)).toBe('记住会议时间')
    expect(proposalTitle(stored, undefined)).toBe(stored)
  })
})
