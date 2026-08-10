import { Check, Search, Target } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'

export type ResearchSetupGuideStepId = 'research-question' | 'initial-intake'

export interface ResearchSetupGuideStep {
  id: ResearchSetupGuideStepId
  title: string
  description: string
  actionLabel: string
  complete: boolean
  icon: ReactNode
  onAction: () => void
}

interface ResearchSetupGuideState {
  hasResearchQuestion: boolean
  hasInitialIntake: boolean
}

export function pendingResearchSetupStepIds(steps: Pick<ResearchSetupGuideStep, 'id' | 'complete'>[]): ResearchSetupGuideStepId[] {
  return steps.filter(step => !step.complete).map(step => step.id)
}

export function ResearchSetupGuide({ steps }: { steps: ResearchSetupGuideStep[] }) {
  const pendingIds = new Set(pendingResearchSetupStepIds(steps))
  const pendingSteps = steps.filter(step => pendingIds.has(step.id))
  if (pendingSteps.length === 0) return null

  const completedCount = steps.length - pendingSteps.length

  return (
    <section className="rounded-lg border border-border bg-card p-4 lg:p-5" aria-label="Auto research next steps">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Next steps</h2>
            <Badge variant="secondary">Auto research</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Complete the setup choices you want to make before the system starts the research workflow.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{completedCount} of {steps.length} complete</span>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {pendingSteps.map(step => (
          <div key={step.id} className="flex min-h-[164px] flex-col rounded-md border border-border bg-background p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-8 items-center justify-center rounded-md border border-border bg-muted/20 text-accent-foreground">
                {step.icon}
              </div>
              <Badge variant="muted">Ready</Badge>
            </div>
            <p className="mt-3 text-sm font-semibold">{step.title}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.description}</p>
            <Button size="sm" variant="outline" className="mt-auto self-start" onClick={step.onAction}>
              {step.icon}
              {step.actionLabel}
            </Button>
          </div>
        ))}
      </div>

      {completedCount > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-success" />
          Completed setup choices are removed from this guide.
        </p>
      )}
    </section>
  )
}

export function defaultResearchSetupGuideSteps(input: ResearchSetupGuideState & {
  onEditQuestion: () => void
  onConfigureInitialIntake: () => void
}): ResearchSetupGuideStep[] {
  return [
    {
      id: 'research-question',
      title: 'Set the research question',
      description: 'Define the question that shapes material intake, screening, and synthesis.',
      actionLabel: input.hasResearchQuestion ? 'Edit question' : 'Set question',
      complete: input.hasResearchQuestion,
      icon: <Target className="size-4" />,
      onAction: input.onEditQuestion,
    },
    {
      id: 'initial-intake',
      title: 'Set up initial material intake',
      description: 'Choose or create source monitors, set the initial history range, and choose the managed model provider.',
      actionLabel: input.hasInitialIntake ? 'Edit intake setup' : 'Set up intake',
      complete: input.hasInitialIntake,
      icon: <Search className="size-4" />,
      onAction: input.onConfigureInitialIntake,
    },
  ]
}
