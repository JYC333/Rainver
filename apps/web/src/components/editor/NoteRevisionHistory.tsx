import { useState } from 'react'
import { History, Undo2 } from 'lucide-react'
import type { NoteRevision, NoteRevisionSource } from '../../types/api'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

const SOURCES: readonly NoteRevisionSource[] = ['user_edit', 'ai_monitoring', 'ai_adhoc', 'seed', 'rollback']

/** Plain text of one top-level Tiptap block, list items on `- ` lines. */
function blockText(block: unknown): string {
  const node = (block ?? {}) as Record<string, unknown>
  const inline = (value: unknown): string => {
    const record = (value ?? {}) as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    return Array.isArray(record.content) ? record.content.map(inline).join('') : ''
  }
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const items = Array.isArray(node.content) ? node.content : []
    return items.map((item, index) => {
      const text = inline(item).trim()
      return text ? `${node.type === 'orderedList' ? `${index + 1}.` : '-'} ${text}` : ''
    }).filter(Boolean).join('\n')
  }
  return inline(node).trim()
}

function docBlocks(doc: Record<string, unknown> | undefined): string[] {
  return Array.isArray(doc?.content) ? doc.content.map(blockText) : []
}

function RevisionDiff({ revision, previous }: { revision: NoteRevision; previous?: NoteRevision }) {
  const { t } = useAppTranslation()
  const ops = revision.diff_json?.ops
  if (revision.diff_json?.rolled_back_to_version) {
    return <p className="text-xs text-muted-foreground">{t('core_ui.editor.restored_version', { version: revision.diff_json.rolled_back_to_version })}</p>
  }
  if (!ops?.length) return <p className="text-xs text-muted-foreground">{t('core_ui.editor.manual_edit')}</p>
  const base = docBlocks(previous?.content_json)
  return (
    <div className="space-y-1.5">
      {revision.diff_json?.conflict && <p className="text-xs font-medium text-warning">{t('core_ui.editor.conflict')}</p>}
      {ops.map((op, index) => (
        <div key={index} className="space-y-1 text-xs">
          {(op.op === 'replace' || op.op === 'delete') && op.index !== undefined && base.slice(op.index, op.index + (op.count ?? 1)).map((text, i) => (
            <pre key={`del-${i}`} className="whitespace-pre-wrap rounded border border-destructive/30 bg-destructive/10 p-2 font-sans text-destructive line-through">{text || t('core_ui.editor.empty_block')}</pre>
          ))}
          {op.op !== 'delete' && (
            <pre className="whitespace-pre-wrap rounded border border-success/40 bg-success/10 p-2 font-sans">{op.markdown}</pre>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Version-history panel shared by every note-taking surface (Knowledge
 * Notes, Project Research notes) — every note save (user or AI) produces a
 * revision, so this is generic, not notebook-specific.
 */
export function NoteRevisionHistory({
  revisions, currentVersion, busy, onRollback,
}: {
  revisions: NoteRevision[] | null
  currentVersion: number
  busy?: boolean
  onRollback: (toVersion: number) => void
}) {
  const [expandedDiff, setExpandedDiff] = useState<number | null>(null)
  const { t } = useAppTranslation()

  return (
    <div className="space-y-2 rounded border border-border/70 bg-muted/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('core_ui.editor.version_history')}</h3>
      {!revisions && <p className="text-xs text-muted-foreground">{t('core_ui.editor.loading')}</p>}
      {revisions?.map((revision, index) => (
        <div key={revision.id} className="rounded border border-border/60 bg-background p-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">v{revision.version}</span>
            <Badge variant={revision.source.startsWith('ai_') ? 'default' : 'outline'}>{SOURCES.includes(revision.source) ? t(`core_ui.editor.source.${revision.source}`) : revision.source}</Badge>
            <span className="text-muted-foreground">{formatDateTime(revision.created_at)}</span>
            {revision.created_by_run_id && <Link className="text-muted-foreground hover:underline" to={`/runs/${revision.created_by_run_id}`}>{t('core_ui.editor.run')}</Link>}
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setExpandedDiff(expandedDiff === revision.version ? null : revision.version)}>
                {expandedDiff === revision.version ? t('core_ui.editor.hide') : t('core_ui.editor.changes')}
              </Button>
              {revision.version !== currentVersion && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onRollback(revision.version)}>{t('core_ui.editor.restore')}</Button>
              )}
            </span>
          </div>
          {expandedDiff === revision.version && (
            <div className="mt-2"><RevisionDiff revision={revision} previous={revisions[index + 1]} /></div>
          )}
        </div>
      ))}
      {revisions && revisions.length === 0 && <p className="text-xs text-muted-foreground">{t('core_ui.editor.no_history')}</p>}
    </div>
  )
}

/** "AI edited this — review or undo" banner shown above the editor. */
export function AiEditBanner({ runId, onUndo, busy }: { runId: string; onUndo: () => void; busy?: boolean }) {
  const { t } = useAppTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-primary/40 bg-primary/5 p-2.5 text-xs">
      <span className="font-medium">{t('core_ui.editor.ai_edited_before')}<Link className="underline" to={`/runs/${runId}`}>{t('core_ui.editor.run')}</Link>{t('core_ui.editor.ai_edited_after')}</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={onUndo}>
        <Undo2 className="size-3.5" />{t('core_ui.editor.undo_ai')}
      </Button>
    </div>
  )
}

/** Status-bar chip that toggles the history panel, matching NoteEditor's Links/Backlinks chips. */
export function HistoryChip({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { t } = useAppTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors ${active ? 'bg-primary/10 text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
    >
      <History className="size-3.5" />
      <span>{t('core_ui.editor.history')}</span>
    </button>
  )
}
