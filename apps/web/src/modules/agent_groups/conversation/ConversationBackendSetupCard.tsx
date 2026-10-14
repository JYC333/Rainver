import { Card } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'

/**
 * Where a Project's conversations get a runtime: an API provider, or a CLI
 * logged in on an execution host (ADR 0016). Each conversation still
 * confirms its Host, CLI and workspace in the execution preflight before its
 * first message, which is where a missing runtime is reported.
 */
export function ConversationBackendSetupCard() {
  return (
    <Card className="bg-muted/20 p-3">
      <p className="text-sm font-medium">Review conversation runtime before the first message.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Open the execution preflight to confirm the Host, CLI, and workspace before sending.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/providers" target="_blank" rel="noreferrer" className="text-sm underline">
          Configure an API provider
        </Link>
        <Link to="/command-center" target="_blank" rel="noreferrer" className="text-sm underline">
          Log a CLI in on an execution host
        </Link>
      </div>
    </Card>
  )
}
