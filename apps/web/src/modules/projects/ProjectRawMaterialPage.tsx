import { useParams } from 'react-router-dom'
import { Inbox } from 'lucide-react'
import { ActivityQueue } from '../activity/ActivityQueue'

/**
 * A Project's raw material, in the Project.
 *
 * The records are the Space's one review queue filtered to this Project — not
 * a second queue, and not a second implementation of one: the list, the
 * filters and the review/archive actions are {@link ActivityQueue}, mounted
 * here pinned. Linking out to the Space Inbox instead was the previous answer
 * and it cost the reader their place in the Project every time they wanted to
 * see what they had captured.
 */
export default function ProjectRawMaterialPage() {
  const { projectId = '' } = useParams()

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4 border-b border-border pb-4">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Inbox className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Raw material</h1>
          <p className="text-sm text-muted-foreground">
            Captured into this project and waiting on you. Nothing becomes memory or changes files without review.
          </p>
        </div>
      </div>

      <ActivityQueue projectId={projectId} />
    </div>
  )
}
