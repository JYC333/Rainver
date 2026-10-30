// Permission-gated maintenance links are covered by their own journey tests.
vi.mock('../../prompts/ReadingMethodEntry',()=>({ReadingMethodEntry:()=>null}))
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InformationDigest } from '../../../types/api'
import i18n from '../../../i18n'
import { InformationDigestView } from '../InformationDigestView'

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

function item(over: Partial<InformationDigest['items'][number]>): InformationDigest['items'][number] {
  return {
    id: 'item-1', source_item_id: 'source-1', section: 'interest', position: 0, quota_slot: 'project:1',
    matched_topic_id: null, serendipity_pool_item_id: null, target_domain_key: null, discovery_origin: null,
    score: 0.9, component_scores: {}, rationale: 'Matches the Project.', title: 'A paper on sparse attention',
    source_uri: null, source_domain: null, author: null, excerpt: null, occurred_at: '2026-10-14T01:00:00Z',
    domain_key: 'artificial_intelligence', depth: 'analysis', genre: 'paper', summary: null, stance_target: null,
    stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0, read_status: 'unread',
    serendipity_feedback: null, anonymous_read_count: null,
    ...over,
  } as InformationDigest['items'][number]
}

function digest(items: InformationDigest['items']): InformationDigest {
  return {
    id: 'digest-1', digest_type: 'project', owner_user_id: null, project_id: 'project-1', digest_date: '2026-10-14',
    profile_maturity: null, status: 'ready', settings: {}, created_at: '2026-10-14T07:00:00Z', updated_at: '2026-10-14T07:00:00Z',
    team_aggregates_available: true, team_blind_spot_domains: [], timezone: 'UTC',
    period_start_utc: '2026-10-14T00:00:00.000Z', period_end_utc: '2026-10-15T00:00:00.000Z',
    generation_kind: 'scheduled', generated_at: '2026-10-14T07:00:00Z', items,
  } as InformationDigest
}

const items = [
  item({ id: 'one', anonymous_read_count: 1 }),
  item({ id: 'many', title: 'Retrieval at scale', anonymous_read_count: 4, score: 1234.5 }),
  item({ id: 'away', section: 'serendipity', title: 'Bird migration', serendipity_feedback: 'never' }),
]

afterEach(async () => { await i18n.changeLanguage('en') })

describe('InformationDigestView', () => {
  it.each(['not_run','analysis_pending','quota_paused','source_failed','no_new'])('labels an empty monitoring day honestly as %s', (coverage)=>{
    render(<InformationDigestView digest={{...digest([]),settings:{ranking:'project_monitoring',coverage}}} project/>);
    expect(screen.queryByText('Nothing new today')).not.toBeInTheDocument();
    expect(screen.getAllByText(i18n.t(`monitoring.${coverage}`)).length).toBeGreaterThan(0);
  });
  it('words sections, team counts and feedback in English', () => {
    render(<InformationDigestView digest={digest(items)} project onSerendipityFeedback={vi.fn()} />)
    expect(screen.getByText('For your interests')).toBeInTheDocument()
    expect(screen.getByText('Outside your usual view')).toBeInTheDocument()
    expect(screen.getByText('1 person read this')).toBeInTheDocument()
    expect(screen.getByText('4 people read this')).toBeInTheDocument()
    expect(screen.getByText('Slot project:1 · score 1,234.500')).toBeInTheDocument()
    expect(screen.getByText('Feedback: Never this direction again')).toBeInTheDocument()
  })

  it('reads in Chinese, keeping titles, rationale and topic labels as written', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<InformationDigestView digest={digest(items)} project onSerendipityFeedback={vi.fn()} />)
    expect(screen.getByText('符合你的兴趣')).toBeInTheDocument()
    expect(screen.getByText('你平时看不到的')).toBeInTheDocument()
    expect(screen.getByText('1 人读过')).toBeInTheDocument()
    expect(screen.getByText('4 人读过')).toBeInTheDocument()
    expect(screen.getByText('反馈：不要再推荐这个方向')).toBeInTheDocument()
    expect(screen.getByText('Retrieval at scale')).toBeInTheDocument()
    expect(screen.getAllByText('Matches the Project.').length).toBe(3)
    expect(screen.getAllByText('artificial_intelligence').length).toBe(3)
  })

  it('says nothing arrived in each language', async () => {
    const { unmount } = render(<InformationDigestView digest={digest([])} />)
    expect(screen.getByText('No annotated items arrived today from your subscribed sources.')).toBeInTheDocument()
    unmount()
    await i18n.changeLanguage('zh-CN')
    render(<InformationDigestView digest={digest([])} project />)
    expect(screen.getByText('今天没有新内容')).toBeInTheDocument()
    expect(screen.getByText('今天没有新纳入并已标注的来源条目进入此项目的语料库。')).toBeInTheDocument()
  })
})
