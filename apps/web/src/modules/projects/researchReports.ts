import type { ProjectResearchReport, ProjectResearchWorkflow } from '../../types/api'

interface ResearchReportView {
  link: ProjectResearchReport
  title: string
  kindLabel: string
  summary: string | null
  question: string
  generatedAt: string
  stale: boolean
}

export function researchReportViews(
  reports: ProjectResearchReport[],
  _workflows: ProjectResearchWorkflow[],
  currentQuestion: string,
): ResearchReportView[] {
  return orderResearchReportsForPresentation(reports).map(report => ({
    link: report,
    title: 'Research report',
    kindLabel: report.status === 'awaiting_review' ? 'Awaiting review' : report.status === 'complete' ? 'Complete' : 'Rejected',
    summary: report.content?.summary ?? null,
    question: report.research_question,
    generatedAt: report.created_at,
    stale: Boolean(currentQuestion.trim() && currentQuestion.trim() !== report.research_question.trim()),
  }))
}

export function latestReadableResearchReport(reports: ProjectResearchReport[]): ProjectResearchReport | null {
  const readable = reports.filter(report => report.status !== 'rejected')
  return [...(readable.length ? readable : reports)].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

function orderResearchReportsForPresentation(reports: ProjectResearchReport[]): ProjectResearchReport[] {
  const latest = latestReadableResearchReport(reports)
  if (!latest) return []
  return [latest, ...reports.filter(report => report.id !== latest.id).sort((a, b) => b.created_at.localeCompare(a.created_at))]
}
