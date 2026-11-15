import { AlertTriangle } from 'lucide-react'
import { useAppTranslation } from '../../i18n'
import type { ImportedSession } from '../../types/api'

type ReadState = Pick<ImportedSession, 'runtime_key' | 'load_state' | 'last_error'>

/** Recognize the recorded refusal; never turn arbitrary vendor output into UI copy. */
export function isImportedSessionBusy(session: ReadState): boolean {
  return session.runtime_key === 'codex_cli' && session.load_state === 'partial'
    && /thread_active_writer|this codex session is in use by another codex client/i.test(session.last_error ?? '')
}

export function ImportedSessionReadNotice({ session }: { session: ReadState }) {
  const { t } = useAppTranslation()
  if (!isImportedSessionBusy(session)) return null
  return <div role="alert" className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    <p>{t('conversation_ui.imported.session_busy_help')}</p>
  </div>
}
