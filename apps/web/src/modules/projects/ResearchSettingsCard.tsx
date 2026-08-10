import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { ProjectResearchSettings } from './useProjectResearch'

/**
 * The saved intake configuration and its item limit.
 *
 * This was a section inside the Project settings dialog on the Overview, which
 * put a Research-only control behind a button whose other half renames the
 * Project. Research configuration belongs to the Research Area.
 */
export function ResearchSettingsCard({ settings }: { settings: ProjectResearchSettings }) {
  const [itemLimitInput, setItemLimitInput] = useState('')
  const proposed = Number(itemLimitInput)
  const disabled = settings.busy
    || !itemLimitInput
    || proposed < 1
    || proposed > 10000
    || (settings.hasLiveOperation && proposed <= (settings.currentItemLimit ?? 0))

  return (
    <Card className="space-y-3 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Research settings</p>
      <div className="rounded-md border border-border bg-muted/20 p-3 text-xs">
        <p className="font-medium text-foreground">Saved intake configuration</p>
        <dl className="mt-2 space-y-1.5 text-muted-foreground">
          <div><dt className="inline font-medium text-foreground">Question: </dt><dd className="inline">{settings.snapshot.question || 'Not set'}</dd></div>
          <div><dt className="inline font-medium text-foreground">Monitors: </dt><dd className="inline">{settings.snapshot.monitors.length ? settings.snapshot.monitors.join(' · ') : 'None selected'}</dd></div>
          <div><dt className="inline font-medium text-foreground">Initial import: </dt><dd className="inline">{settings.snapshot.history}</dd></div>
          <div><dt className="inline font-medium text-foreground">Import limit: </dt><dd className="inline">{settings.snapshot.maxItems?.toLocaleString() ?? 'Not set'} items shared across monitors (initial import only)</dd></div>
          <div><dt className="inline font-medium text-foreground">Monitoring: </dt><dd className="inline">{settings.snapshot.monitoringField}</dd></div>
        </dl>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label>Item limit</Label>
          <span className="text-sm font-medium">{settings.currentItemLimit !== null ? settings.currentItemLimit.toLocaleString() : '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={10000}
            placeholder={settings.currentItemLimit !== null ? String(settings.currentItemLimit) : 'e.g. 10000'}
            value={itemLimitInput}
            onChange={event => setItemLimitInput(event.target.value)}
            aria-label="New item limit"
          />
          <Button
            variant="outline"
            onClick={() => {
              settings.onUpdateItemLimit(proposed)
              setItemLimitInput('')
            }}
            disabled={disabled}
          >
            Update
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.hasLiveOperation
            ? 'Intake is already running; this can only be raised, not lowered.'
            : 'Applies once material intake starts. Saved to the intake setup draft now.'}
        </p>
      </div>
    </Card>
  )
}
