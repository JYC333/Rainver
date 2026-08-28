import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, MessageSquarePlus, Terminal, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi, projectsApi, roomsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link, useSpaceNavigate } from '../../core/spaceNav'
import type { ImportedSession, ImportedSessionRecord } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'

/**
 * One imported CLI session, read-only.
 *
 * There is no composer, and that absence is the point: this is a transcript
 * of work done elsewhere, not a conversation Rainver can continue. Continuing
 * from it means starting a Rainver conversation seeded from what was
 * extracted, never resuming the vendor's own session.
 *
 * Above the transcript is a derived view — files touched, commands run — that
 * is computed from the records rather than written by a model, so it is
 * available the moment an import lands and costs nothing.
 */
export default function ImportedSessionView() {
  const { projectId = '', sessionId = '' } = useParams()
  const navigate = useSpaceNavigate()
  const [continuing, setContinuing] = useState(false)
  const [session, setSession] = useState<ImportedSession | null>(null)
  const [records, setRecords] = useState<ImportedSessionRecord[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await ambientSessionsApi.records(sessionId)
      setSession(result.session)
      setRecords(result.records)
      setTruncated(result.truncated)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load])

  const derived = useMemo(() => deriveActivity(records), [records])

  /**
   * Starts a Rainver conversation seeded from this session — never a resume of
   * the vendor's own (ADR 0004): the seed is Rainver's own record of what
   * happened, so the new conversation is governed, snapshotted, and auditable
   * like any other, and nothing depends on vendor state that may already be
   * gone.
   */
  async function continueHere() {
    if (!session) return
    setContinuing(true)
    try {
      const { room } = await projectsApi.mainlineRoom(projectId)
      if (!room) throw new Error('This Project has no mainline Room to continue in')
      const conversation = await roomsApi.createConversation(room.id, {
        title: `Continuing: ${session.title ?? 'imported session'}`,
      })
      // The seed is a draft in the real composer, not a message sent from
      // here: recipients and backends are the Room's to resolve, and a second
      // dispatch path beside it is exactly the duplication to avoid.
      // Derived from the conversation, not carried in the URL: a link that
      // named its own key could paste any same-origin stored value into the
      // composer.
      const key = `rainver.seed.${conversation.id}`
      try {
        sessionStorage.setItem(key, seedMessage(session, records, derived, truncated))
      } catch { /* a draft is not worth failing over */ }
      navigate(`/projects/${projectId}/rooms?room=${room.id}&conversation=${conversation.id}&seed=1`)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setContinuing(false)
    }
  }

  if (loading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>
  if (!session) return <div className="p-6 text-sm text-muted-foreground">This imported session is not available.</div>

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/projects/${projectId}/conversations`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            <ArrowLeft className="size-3" />Conversations
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">{session.title ?? 'Imported session'}</h1>
          <p className="text-sm text-muted-foreground">
            Imported from {session.adapter_type}
            {session.cwd && ` · ${session.cwd}`}
            {session.last_record_at && ` · ${new Date(session.last_record_at).toLocaleString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Offered only for a shared session. The mainline Room is the
              Project's, so seeding it from a session the person kept to
              themselves would move private content across the boundary they
              chose — quietly, and through a button that says nothing about
              it. Sharing the session first is the explicit act. */}
          {session.visibility !== 'private' && (
            <Button size="sm" variant="outline" disabled={continuing} onClick={() => void continueHere()}>
              <MessageSquarePlus className="size-4" />Continue in Rainver
            </Button>
          )}
          <Badge variant="outline">Read-only</Badge>
          {session.visibility === 'private' && <Badge variant="outline">Only you</Badge>}
          {session.load_state === 'partial' && <Badge variant="outline">Partial replay</Badge>}
          {session.source_state === 'gone' && (
            <Badge variant="outline" className="flex items-center gap-1">
              <AlertTriangle className="size-3" />No longer on the host
            </Badge>
          )}
        </div>
      </div>

      {(derived.files.length > 0 || derived.commands.length > 0) && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">What this session did</h2>
          {derived.files.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Files touched</h3>
              <ul className="mt-1 space-y-0.5 text-sm">
                {derived.files.slice(0, 20).map(file => <li key={file} className="truncate font-mono text-xs">{file}</li>)}
              </ul>
            </div>
          )}
          {derived.commands.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Commands run</h3>
              <ul className="mt-1 space-y-0.5 text-sm">
                {derived.commands.slice(0, 20).map((command, index) => (
                  <li key={`${command.tool}-${index}`} className="truncate font-mono text-xs">
                    {command.tool}
                    {command.status && <span className="text-muted-foreground"> · {command.status}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="space-y-2">
        {records.map(record => <RecordRow key={record.id} record={record} />)}
        {truncated && (
          <p className="text-xs text-muted-foreground">
            This session is longer than what is shown; the rest was not loaded.
          </p>
        )}
      </div>
    </div>
  )
}

function RecordRow({ record }: { record: ImportedSessionRecord }) {
  if (record.kind === 'tool_call') {
    return (
      <Card className="flex items-start gap-2 p-3 text-xs">
        <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{record.tool_name ?? 'Tool call'}{record.tool_status && ` · ${record.tool_status}`}</div>
          {record.tool_input && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{record.tool_input}</pre>}
          {record.tool_output && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
              {record.tool_output}{record.truncated && ' …'}
            </pre>
          )}
        </div>
      </Card>
    )
  }
  if (record.kind === 'user_message' || record.kind === 'agent_message') {
    return (
      <Card className="p-3">
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          {record.kind === 'user_message' ? 'You' : 'Agent'}
        </div>
        <p className="whitespace-pre-wrap break-words text-sm">{record.text}{record.truncated && ' …'}</p>
      </Card>
    )
  }
  return (
    <Card className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
      <Terminal className="size-3.5" />{record.kind === 'plan' ? 'Plan' : 'Other activity'}
    </Card>
  )
}

/**
 * Files and commands, read straight out of the tool calls.
 *
 * Deterministic on purpose: it needs no model, it is available the instant an
 * import lands, and it says only what the records actually contain.
 */
export function deriveActivity(records: readonly ImportedSessionRecord[]): {
  files: string[]
  commands: Array<{ tool: string; status: string | null }>
} {
  const files = new Set<string>()
  const commands: Array<{ tool: string; status: string | null }> = []
  for (const record of records) {
    if (record.kind !== 'tool_call') continue
    commands.push({ tool: record.tool_name ?? 'tool', status: record.tool_status })
    if (!record.tool_input) continue
    for (const match of record.tool_input.matchAll(/["']((?:\/|\.\/|[\w.-]+\/)[\w./-]+\.[\w]{1,8})["']/g)) {
      const path = match[1]
      if (path) files.add(path)
    }
  }
  return { files: [...files], commands }
}

/**
 * The seed for a continued conversation.
 *
 * Deliberately the deterministic view plus the last few things actually said,
 * not a model's summary: it is available immediately, it cannot invent
 * anything, and the agent reading it can ask for more from the Project's own
 * context if it needs to.
 */
function seedMessage(
  session: ImportedSession,
  records: readonly ImportedSessionRecord[],
  derived: ReturnType<typeof deriveActivity>,
  truncated: boolean,
): string {
  const said = records
    .filter(record => record.kind === 'user_message' || record.kind === 'agent_message')
    .slice(-6)
    .map(record => `${record.kind === 'user_message' ? 'Me' : 'Agent'}: ${(record.text ?? '').slice(0, 400)}`)
  return [
    `Picking up from a ${session.adapter_type} session imported into this Project`
      + `${session.title ? ` ("${session.title}")` : ''}.`,
    derived.files.length > 0 ? `Files it touched: ${derived.files.slice(0, 15).join(', ')}` : null,
    derived.commands.length > 0
      ? `Commands it ran: ${derived.commands.slice(0, 10).map(command => command.tool).join(', ')}`
      : null,
    said.length > 0
      // Said plainly when it is not actually the end: the page is capped, so
      // for a long session these are the last six of what was loaded.
      ? `${truncated ? 'Where the loaded part left off' : 'How it ended'}:\n${said.join('\n')}`
      : null,
  ].filter(Boolean).join('\n\n')
}
