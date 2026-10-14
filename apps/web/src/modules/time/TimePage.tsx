import { Clock } from 'lucide-react'
import { Badge } from '../../components/ui/badge'

export default function TimePage() {
  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <Clock className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">Time <Badge variant="muted">Planned</Badge></h1>
          <p className="text-sm text-muted-foreground">Track time records and convert them into activity summaries.</p>
        </div>
      </div>
      <div className="border border-dashed border-border rounded-lg p-12 text-center">
        <p className="text-sm text-muted-foreground">Time tracking is planned and not available yet. Nothing here records or stores time.</p>
      </div>
    </div>
  )
}
