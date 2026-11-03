import {act,render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import type {Briefing} from '@rainver/protocol'
import {TopicAnalysisArchive} from '../reading/TopicAnalysisArchive'
import {projectReadingApi} from '../../../api/client'
import {clearSessionResidue} from '../../../lib/sessionResidue'
vi.mock('../../../api/client',()=>({projectReadingApi:{archivedTheme:vi.fn()}}))
beforeEach(()=>vi.clearAllMocks())
const ITEM = '11111111-1111-4111-8111-111111111111'

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    id: 'b1', version: 1, kind: 'manual', status: 'ready', outcome: 'briefing', comparison: 'baseline', period_date: null,
    cutoff_at: '2026-10-30T08:00:00.000Z', created_at: '2026-10-30T08:00:00.000Z', completed_at: '2026-10-30T08:02:00.000Z', checked_at: null, error_code: null,
    scope_type: 'project', previous_briefing_id: null, run_status: null,
    coverage: { since: null, cutoff: '2026-10-30T08:00:00.000Z', candidates: 3, included: 1, merged_duplicates: 1, not_ready: 1, truncated: 0, egress_refused: 0, not_shared_with_audience: 0, carried_from_previous: 0, unchanged_since_previous: 0, background: 0, context_changed: false, complete: false },
    visibility: 'visible', hidden_units: 0,
    overview: { text: 'One launch dominates.', refs: ['S1'] },
    highlights: [{
      title: 'Gripper launch', what_changed: 'A soft gripper shipped.', novelty: 'baseline', importance: 'high', why_it_matters: 'Fragile items.',
      impact: { assessment: 'insufficient_context', text: 'No Task covers grippers.', context_refs: [] }, suggested_action: 'watch',
      statements: [{ kind: 'fact', text: 'It shipped.', refs: ['S1'] }, { kind: 'inference', text: 'It may replace ours.', refs: ['S1', 'C1'] }],
      contradictions: null, refs: ['S1'], source_domains: 1, rests_on_unverified: true, index: 0,
    }],
    open_questions: [],
    evidence: [{ key: 'S1', source_item_id: ITEM, original_snapshot_id:'archived-original',title: 'Gripper report', source_domain: 'news.test', occurred_at: null, delta_class: 'baseline', unverified: true, lenses: [{ kind: 'corpus', label: 'Project Corpus' }] }],
    context: [{ key: 'C1', kind: 'project_goal', label: 'Project goal' }],
    context_outdated: false,
    ...overrides,
  }
}

const archive=(project='p')=><MemoryRouter><TopicAnalysisArchive space="s" project={project} id="b1"/></MemoryRouter>
it('reads exact topic history behind the theme projection and clears on logout',async()=>{
 vi.mocked(projectReadingApi.archivedTheme).mockResolvedValue(briefing());render(archive());await screen.findByText('One launch dominates.');
 expect(screen.getAllByRole('link',{name:'View source: Gripper report'})[0]).toHaveAttribute('href',expect.stringContaining('version=archived-original'));
 expect(projectReadingApi.archivedTheme).toHaveBeenCalledWith('s','p','b1',expect.anything());
 act(()=>clearSessionResidue());expect(screen.queryByText('One launch dominates.')).toBeNull();
});
it('withdrawn access removes the body, including a late reply after switching project',async()=>{
 let resolve!:(b:Briefing)=>void;vi.mocked(projectReadingApi.archivedTheme).mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockRejectedValue(Object.assign(new Error('Access changed'),{status:403}));
 const view=render(archive());view.rerender(archive('p2'));await screen.findByText('Access changed');await act(async()=>resolve(briefing()));expect(screen.queryByText('One launch dominates.')).toBeNull();
});
