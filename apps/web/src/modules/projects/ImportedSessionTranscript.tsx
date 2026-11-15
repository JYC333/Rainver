import { ChevronDown, Terminal, Wrench } from 'lucide-react'
import type { ImportedSessionRecord } from '../../types/api'
import { useAppTranslation } from '../../i18n'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { Tool, ToolContent, ToolHeader } from '../../components/ai-elements/tool'

type TranscriptEntry = { kind: 'message'; record: ImportedSessionRecord }
  | { kind: 'activity'; records: ImportedSessionRecord[] }

/** Keep source order and record identities; only consecutive activity is folded. */
function transcriptEntries(records: ImportedSessionRecord[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const record of records) {
    if (record.kind === 'user_message' || record.kind === 'agent_message') {
      entries.push({ kind: 'message', record })
    } else {
      const previous = entries[entries.length - 1]
      if (previous?.kind === 'activity') previous.records.push(record)
      else entries.push({ kind: 'activity', records: [record] })
    }
  }
  return entries
}

export function ImportedSessionTranscript({ records, pickable, picked, onPickedChange }: {
  records: ImportedSessionRecord[]
  pickable: boolean
  picked: string[]
  onPickedChange: (recordId: string, next: boolean) => void
}) {
  const { t } = useAppTranslation()
  const row = (record: ImportedSessionRecord) => <RecordRow
    key={record.id}
    record={record}
    pickable={pickable}
    picked={picked.includes(record.id)}
    onPickedChange={next => onPickedChange(record.id, next)}
  />
  return <div className="space-y-2">
    {transcriptEntries(records).map(entry => {
      if (entry.kind === 'message') return row(entry.record)
      const selected = entry.records.filter(record => picked.includes(record.id)).length
      return <Collapsible key={entry.records[0]!.id} className="min-w-0" data-testid="imported-activity">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group h-auto max-w-full justify-start whitespace-normal py-2 text-left">
            <Wrench className="size-3.5 shrink-0" />
            {t('conversation_ui.imported.activity', { count: entry.records.length })}
            {selected > 0 && <span>{t('conversation_ui.imported.picked', { count: selected })}</span>}
            <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 border-l border-border pl-2">
          {entry.records.map(row)}
        </CollapsibleContent>
      </Collapsible>
    })}
  </div>
}

function RecordRow({ record, pickable, picked, onPickedChange }: {
  record: ImportedSessionRecord
  pickable: boolean
  picked: boolean
  onPickedChange: (picked: boolean) => void
}) {
  const { t } = useAppTranslation()
  return <div className={`group flex items-start gap-2 rounded ${picked ? 'bg-accent/40' : ''}`}>
    {pickable && <label className={`flex shrink-0 items-start pt-2 ${picked ? '' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'}`}>
      <input type="checkbox" checked={picked} aria-label={t('conversation_ui.imported.pick_record')}
        onChange={event => onPickedChange(event.target.checked)} />
    </label>}
    <div className="min-w-0 flex-1"><RecordBody record={record} /></div>
  </div>
}

function RecordBody({ record }: { record: ImportedSessionRecord }) {
  const { t } = useAppTranslation()
  if (record.kind === 'tool_call') {
    return <Tool>
      <ToolHeader type="dynamic-tool" title={record.tool_name ?? t('conversation_ui.imported.tool_call')}
        state="output-available" statusIndicator={<span className="text-[11px] text-muted-foreground">{record.tool_status}</span>} />
      <ToolContent>
        {record.tool_input && <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{record.tool_input}</pre>}
        {record.tool_output && <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{record.tool_output}{record.truncated && ' …'}</pre>}
      </ToolContent>
    </Tool>
  }
  if (record.kind === 'user_message' || record.kind === 'agent_message') {
    return <Card className="mb-0 p-3">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {t(record.kind === 'user_message' ? 'conversation_ui.imported.you' : 'conversation_ui.imported.agent')}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{record.text}{record.truncated && ' …'}</p>
    </Card>
  }
  return <Collapsible>
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size="sm" className="group max-w-full justify-start">
        <Terminal className="size-3.5 shrink-0" />
        {t(record.kind === 'plan' ? 'conversation_ui.imported.plan' : 'conversation_ui.imported.other_activity')}
        <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <pre className="whitespace-pre-wrap break-words p-2 text-xs text-muted-foreground">{record.text ?? (typeof record.raw_json === 'string' ? record.raw_json : JSON.stringify(record.raw_json, null, 2))}{record.truncated && ' …'}</pre>
    </CollapsibleContent>
  </Collapsible>
}
