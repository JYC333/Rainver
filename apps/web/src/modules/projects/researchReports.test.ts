// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProjectResearchReport } from '../../types/api'
import { researchReportViews } from './researchReports'

const report = (overrides: Partial<ProjectResearchReport> = {}): ProjectResearchReport => ({
  id: 'report-1', project_id: 'project-1', workflow_id: 'workflow-1', operation_id: 'operation-1', synthesis_run_id: 'run-1',
  run_kind: 'baseline', research_question: 'Question A', research_question_version: 1, status: 'awaiting_review',
  created_at: '2026-07-18T10:00:00Z', updated_at: '2026-07-18T10:00:00Z', ...overrides,
})

describe('researchReportViews', () => {
  it('uses immutable report provenance and status', () => {
    const [view] = researchReportViews([report()], [], 'Question B')
    expect(view).toMatchObject({ question: 'Question A', kindLabel: 'Awaiting review', stale: true })
  })
  it('reads a detail summary when available', () => {
    const [view] = researchReportViews([report({ content: { schema_version: 'research_report.v1', research_question: 'Question A', summary: 'Mixed evidence', findings: [], sources: [], limitations: [], ideas: [] } })], [], 'Question A')
    expect(view.summary).toBe('Mixed evidence')
  })
  it('orders newest first', () => {
    const views = researchReportViews([report({ id: 'old', created_at: '2026-07-17T00:00:00Z' }), report({ id: 'new' })], [], '')
    expect(views.map(view => view.link.id)).toEqual(['new', 'old'])
  })
  it('keeps a rejected report in history instead of making it the latest report', () => {
    const views = researchReportViews([
      report({ id: 'readable', status: 'complete', created_at: '2026-07-17T00:00:00Z' }),
      report({ id: 'rejected', status: 'rejected', created_at: '2026-07-19T00:00:00Z' }),
    ], [], '')
    expect(views.map(view => view.link.id)).toEqual(['readable', 'rejected'])
  })
  it('uses the newest rejected report only when no readable report exists', () => {
    const views = researchReportViews([
      report({ id: 'older', status: 'rejected', created_at: '2026-07-17T00:00:00Z' }),
      report({ id: 'newer', status: 'rejected', created_at: '2026-07-19T00:00:00Z' }),
    ], [], '')
    expect(views[0]?.link.id).toBe('newer')
  })
})
