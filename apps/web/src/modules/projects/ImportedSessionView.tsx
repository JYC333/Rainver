import { useCallback, useEffect, useMemo, useState } from 'react'
import { holdReferences } from '../agent_groups/pendingReferences'
import { useParams } from 'react-router-dom'
import { deriveAmbientActivity } from '@rainver/protocol'
import { AlertTriangle, ArrowLeft, MessageSquarePlus, ChevronDown, Quote, X } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi, projectsApi, roomsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link, useSpaceNavigate } from '../../core/spaceNav'
import type { ImportedSession, ImportedSessionRecord } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { ImportedSessionReadNotice, isImportedSessionBusy } from './ImportedSessionReadNotice'
import { ImportedSessionTranscript } from './ImportedSessionTranscript'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible'
import { Skeleton } from '../../components/ui/skeleton'

/**
 * Everyone in the Project's mainline can already read all of this.
 *
 * Not "not private": `selected_users`, and `space_shared` demoted to `summary`
 * access, both name an audience narrower than the Project's readers, so
 * carrying one into the mainline is a disclosure. One function rather than a
 * copy per caller — the destination, the button's affordances and the
 * write-authority probe all have to agree, and two copies is how they stop.
 */
function isFullyShared(session: Pick<ImportedSession, 'visibility' | 'access_level'> | null): boolean {
  return session?.visibility === 'space_shared' && session.access_level === 'full'
}

/**
 * One imported CLI session, read-only.
 *
 * There is no composer. This is a transcript
 * of work done elsewhere, not a conversation Rainver can continue. Continuing
 * from it means starting a Rainver conversation seeded from what was
 * extracted, never resuming the vendor's own session.
 *
 * Above the transcript is a derived view — files touched, commands run — that
 * is computed from the records rather than written by a model, so it is
 * available the moment an import lands and costs nothing.
 */
export default function ImportedSessionView() {
  const { t } = useAppTranslation()
  const { projectId = '', sessionId = '' } = useParams()
  const navigate = useSpaceNavigate()
  const [continuing, setContinuing] = useState(false)
  /** Records chosen to be carried, rather than the whole session's summary. */
  const [picked, setPicked] = useState<string[]>([])
  /**
   * Continuing a private session opens the person's own Room, which needs
   * write authority on the Project; continuing a shared one only reads the
   * mainline. A reader who owns a private session would otherwise press the
   * button and get a bare 403.
   */
  const [canWrite, setCanWrite] = useState(true)
  const [session, setSession] = useState<ImportedSession | null>(null)
  const [records, setRecords] = useState<ImportedSessionRecord[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await ambientSessionsApi.records(sessionId)
      // Only where continuing opens a personal Room, which needs write
      // authority. `mainlineRoom` is not a free read — it enrols the viewer in
      // the mainline and bumps its roster revision — so a fully shared
      // session, which continues there anyway, must not trigger it.
      //
      // The same `fullyShared` test as the destination and the button. Do not
      // probe `private` alone. A narrowly-shared session would leave `canWrite`
      // at its optimistic default and offer a button that 403s on the press.
      if (!isFullyShared(result.session)) {
        setCanWrite(await projectsApi.mainlineRoom(projectId).then(
          page => page.viewer_can_write,
          () => true,
        ))
      }
      setSession(result.session)
      setRecords(result.records)
      setTruncated(result.truncated)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [projectId, sessionId])

  useEffect(() => { void load() }, [load])

  const derived = useMemo(() => deriveAmbientActivity(records), [records])

  /**
   * Everyone in the Project's mainline can already read all of this.
   *
   * Not "not private": `selected_users`, and `space_shared` demoted to
   * `summary` access, both name an audience narrower than the Project's
   * readers, so carrying one into the mainline is a disclosure. Both the
   * destination and the button's own affordances key on this single test, so
   * they cannot drift apart.
   */
  const fullyShared = isFullyShared(session)

  /**
   * Starts a Rainver conversation carrying this session — never a resume of
   * the vendor's own (ADR 0004). What travels is a *reference*: Rainver's own
   * copy of the session, made once and stamped with its provenance, so the
   * new conversation is governed, snapshotted and auditable like any other
   * and nothing depends on vendor state that may already be gone.
   */
  async function continueHere(recordIds: string[] = []) {
    if (!session) return
    setContinuing(true)
    try {
      // Where it lands follows the session's own audience, and the test is
      // "everyone can already read all of it" — not merely "not private".
      // `selected_users`, and `space_shared` demoted to `summary` access, both
      // name an audience narrower than the Project's readers, so continuing
      // one in the mainline would be a disclosure the server refuses without
      // a confirmation. Do not ask it on a continuation. The person opened a
      // session to carry on working, not to decide who else should read it,
      // and the answer that costs nothing is available: anything short of
      // fully shared continues in their personal Room, whose audience is a
      // subset of every source, so no disclosure arises at all.
      const roomId = fullyShared
        ? (await projectsApi.mainlineRoom(projectId)).room.id
        : (await roomsApi.create({
            project_id: projectId,
            title: 'Just me',
            personal: true,
          })).room.id
      // Held for the composer, which sends it with the first message so the
      // reference and the conversation are written together. No conversation
      // is created here — sending is what creates one (ADR 0018 decision 5) —
      // so abandoning the draft leaves nothing behind. Picked records travel
      // as themselves. Otherwise the whole session travels, and that grain
      // carries a summary.
      holdReferences(roomId, [recordIds.length > 0
            ? { kind: 'imported_records', id: session.id, item_ids: recordIds }
            : { kind: 'imported_session', id: session.id }])
      navigate(`/projects/${projectId}/rooms?room=${roomId}&new=1&reference=1`)
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
            Imported from {session.runtime_key}
            {session.cwd && ` · ${session.cwd}`}
            {session.last_record_at && ` · ${new Date(session.last_record_at).toLocaleString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Offered for a restricted session too. It continues in the
              person's own Room rather than the Project's, so the boundary they
              chose holds without the button having to be withheld.
              The condition is `fullyShared`, the same test the destination
              uses — keying this on `private` alone would offer a `Continue in
              Rainver` button to a reader whose session lands in a personal
              Room they cannot create. */}
          {!fullyShared && !canWrite ? (
            <span className="text-xs text-muted-foreground">
              Continuing this privately needs write access to the Project.
            </span>
          ) : (
            <Button size="sm" variant="outline" disabled={continuing} onClick={() => void continueHere()}>
              <MessageSquarePlus className="size-4" />
              {fullyShared ? 'Continue in Rainver' : 'Continue privately'}
            </Button>
          )}
          <Badge variant="outline">Read-only</Badge>
          {session.visibility === 'private' && <Badge variant="outline">Only you</Badge>}
          {session.load_state === 'partial' && <Badge variant="outline">{isImportedSessionBusy(session) ? t('conversation_ui.imported.session_busy') : 'Partial replay'}</Badge>}
          {session.source_state === 'gone' && (
            <Badge variant="outline" className="flex items-center gap-1">
              <AlertTriangle className="size-3" />No longer on the host
            </Badge>
          )}
        </div>
      </div>

      <ImportedSessionReadNotice session={session} />

      {(derived.files.length > 0 || derived.commands.length > 0) && (
        <Collapsible asChild>
          <Card className="mb-0 p-2">
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost" className="group h-auto w-full justify-between whitespace-normal text-left">
                {t('conversation_ui.imported.session_activity')}
                <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 p-2">
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
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {/* The same guard as the header button, not a second judgement. A
          personal-Room destination needs Project write, and offering the
          action here without checking is how a reader gets a 403 and loses
          what they picked. */}
      {picked.length > 0 && (fullyShared || canWrite) && (
        <Card className="sticky top-2 z-10 flex flex-wrap items-center gap-2 p-2 text-sm">
          <Quote className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{picked.length} {picked.length === 1 ? 'record' : 'records'} picked</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={continuing} onClick={() => void continueHere(picked)}>
              <MessageSquarePlus className="size-4" />
              {fullyShared ? 'Use in Rainver' : 'Use privately'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked([])} aria-label="Cancel picking">
              <X className="size-3.5" />
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-2">
        <ImportedSessionTranscript
          key={sessionId}
          records={records}
          pickable={fullyShared || canWrite}
          picked={picked}
          onPickedChange={(id, next) => setPicked(current => next
            ? [...current, id]
            : current.filter(pickedId => pickedId !== id))}
        />
        {truncated && (
          <p className="text-xs text-muted-foreground">
            This session is longer than what is shown; the rest was not loaded.
          </p>
        )}
      </div>
    </div>
  )
}
