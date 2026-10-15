import { afterEach, describe, expect, it } from 'vitest'
import i18n from './index'

// Counts on the Usage, Memories and digest pages pick their plural form from
// the count, in each language.

afterEach(async () => { await i18n.changeLanguage('en') })

const counts = [0, 1, 7]

describe('workspace_ui plurals', () => {
  it('words 0, 1 and many in English', () => {
    expect(counts.map(count => i18n.t('workspace_ui.memories.scanned', { count }))).toEqual(['0 scanned', '1 scanned', '7 scanned'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.kpi.events', { count, formatted: String(count) }))).toEqual(['0 events', '1 event', '7 events'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.runs', { count, formatted: String(count) }))).toEqual(['0 runs', '1 run', '7 runs'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.days', { count }))).toEqual(['0 days', '1 day', '7 days'])
    expect(counts.map(count => i18n.t('workspace_ui.digest.people_read', { count }))).toEqual(['0 people read this', '1 person read this', '7 people read this'])
  })

  it('words 0, 1 and many in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(counts.map(count => i18n.t('workspace_ui.memories.scanned', { count }))).toEqual(['已扫描 0 条', '已扫描 1 条', '已扫描 7 条'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.kpi.events', { count, formatted: String(count) }))).toEqual(['0 个事件', '1 个事件', '7 个事件'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.runs', { count, formatted: String(count) }))).toEqual(['0 次运行', '1 次运行', '7 次运行'])
    expect(counts.map(count => i18n.t('workspace_ui.usage.days', { count }))).toEqual(['0 天', '1 天', '7 天'])
    expect(counts.map(count => i18n.t('workspace_ui.digest.people_read', { count }))).toEqual(['0 人读过', '1 人读过', '7 人读过'])
  })
})
