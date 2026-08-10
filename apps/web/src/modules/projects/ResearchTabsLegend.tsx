import { BookOpen, HelpCircle, Search } from 'lucide-react'
import { SpaceLink as Link } from '../../core/spaceNav'

/**
 * Once initial intake has started, the per-step "Next steps" guide
 * (ResearchSetupGuide) disappears and nothing else on Overview explains
 * which of the Project Shell's ~10 Areas the ongoing research loop actually
 * touches. This is a compass, not a task list: it never disappears on its
 * own, since a returning user needs the same orientation every visit.
 */
export function ResearchTabsLegend({ projectId }: { projectId: string }) {
  return (
    <section aria-label="Where Project Research work happens" className="rounded-lg border border-border bg-muted/10 p-4 lg:p-5">
      <h2 className="text-sm font-semibold">Where this Project's Areas fit in</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The research loop lives in three Areas. Everything else becomes useful once you have findings to act on.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-xs font-medium"><Search className="size-3.5 text-accent-foreground" />This page (Overview)</div>
          <p className="mt-1.5 text-xs text-muted-foreground">Drives the pipeline — scan, screen, synthesize run here automatically. Any review checkpoint (approve/reject) appears on this page.</p>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-xs font-medium"><HelpCircle className="size-3.5 text-accent-foreground" />
            <Link className="hover:underline" to={`/projects/${projectId}/inquiry`}>Inquiry</Link>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">Review new evidence as Candidates, and track the Questions/Hypotheses this research is answering.</p>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-xs font-medium"><BookOpen className="size-3.5 text-accent-foreground" />
            <Link className="hover:underline" to={`/projects/${projectId}/research`}>Research Area</Link>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">Your reading list, checklist, and generated report snapshots. Working notes live in Project Notes.</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Experiments, Decisions, Learning, Delivery, and Operations stay reachable, but there is nothing to do there until this research produces a result worth acting on.
      </p>
    </section>
  )
}
