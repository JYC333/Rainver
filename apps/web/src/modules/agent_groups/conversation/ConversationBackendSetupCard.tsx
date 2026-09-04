import { Card } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'

/**
 * The actionable recovery when a Conversation cannot provision or resolve its
 * Project Agent runtime. Both Room surfaces use this one card so a blocked
 * setup remains visible while the full page offers real destinations.
 */
export function ConversationBackendSetupCard({
  setupTargets,
  mode = 'retry',
}: {
  setupTargets: string[]
  mode?: 'retry' | 'prepare'
}) {
  return (
    <Card className={mode === 'retry' ? 'border-amber-500/40 bg-amber-500/5 p-3' : 'bg-muted/20 p-3'}>
      <p className="text-sm font-medium">
        {mode === 'retry'
          ? 'Set up a conversation backend to send this message.'
          : 'Review conversation runtime before the first message.'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {mode === 'retry'
          ? 'Setup opens in a new tab so this draft stays here. Return and send it again when ready.'
          : 'Open the execution preflight to confirm the Host, CLI, and workspace before sending.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {setupTargets.includes('model_providers') && (
          <Link to="/providers" target="_blank" rel="noreferrer" className="text-sm underline">
            Configure an API provider
          </Link>
        )}
        {setupTargets.includes('cli_credentials') && (
          <Link to="/cli-profiles" target="_blank" rel="noreferrer" className="text-sm underline">
            Grant a server CLI credential
          </Link>
        )}
        <Link to="/command-center" target="_blank" rel="noreferrer" className="text-sm underline">
          Pair or sign in on a host CLI
        </Link>
      </div>
    </Card>
  )
}
