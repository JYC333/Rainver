import { useState, useEffect, useCallback, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { useSearchParams } from 'react-router-dom'
import { sessionsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg, isNotFoundError } from '../../lib/utils'
import type { Session, Message } from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Textarea } from '../../components/ui/textarea'
import { StatusBadge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table'
import { ProjectFolderSelectors } from '../../components/ProjectFolderSelectors'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'

const MESSAGE_ROLES = new Set(['user', 'assistant', 'system'])

export default function SessionsPage() {
  const { activeSpaceId, activeSpaceName } = useSpace()
  const { t } = useAppTranslation()
  const [searchParams] = useSearchParams()
  const [sessions, setSessions]             = useState<Session[]>([])
  const [activeSession, setActiveSession]   = useState<Session | null>(null)
  const [sessionNotFound, setSessionNotFound] = useState(false)
  const [messages, setMessages]             = useState<Message[]>([])
  const [title, setTitle]                   = useState('')
  const [projectId, setProjectId]           = useState('')
  const [folder, setFolder]           = useState('')
  const [msgInput, setMsgInput]             = useState('')
  const [loading, setLoading]               = useState(false)
  const autoOpenRef = useRef(false)

  const loadSessions = useCallback(async () => {
    if (!activeSpaceId) {
      setSessions([])
      return
    }
    try { setSessions((await sessionsApi.list()).items) }
    catch (e) { toast.error(errMsg(e)) }
  }, [activeSpaceId])

  useEffect(() => { loadSessions() }, [loadSessions])

  // Auto-open a specific session when deep-linked via ?open=<sessionId> (e.g. from Space Today).
  useEffect(() => {
    if (autoOpenRef.current) return
    const openId = searchParams.get('open')
    if (!openId) return
    autoOpenRef.current = true
    openSession(openId)
  // openSession is redeclared every render; the deep link is honoured once, guarded by autoOpenRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  async function createSession() {
    if (!activeSpaceId) {
      toast.error(t('sessions_ui.sessions.no_space_create'))
      return
    }
    try {
      await sessionsApi.create({ title: title || undefined, project_id: projectId || undefined, project_folder_id: folder || undefined })
      setTitle(''); setProjectId(''); setFolder('')
      toast.success(t('sessions_ui.sessions.created'))
      await loadSessions()
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function openSession(id: string) {
    setSessionNotFound(false)
    try {
      const [sess, msgs] = await Promise.all([sessionsApi.get(id), sessionsApi.messages(id)])
      setActiveSession(sess)
      setMessages(msgs)
    } catch (e) {
      if (isNotFoundError(e)) {
        setActiveSession(null)
        setMessages([])
        setSessionNotFound(true)
      } else {
        toast.error(errMsg(e))
      }
    }
  }

  async function sendMessage() {
    if (!activeSession || !msgInput.trim()) return
    try {
      await sessionsApi.addMessage(activeSession.id, { content: msgInput.trim() })
      setMsgInput('')
      setMessages(await sessionsApi.messages(activeSession.id))
    } catch (e) { toast.error(errMsg(e)) }
  }

  async function reflect() {
    if (!activeSession) return
    setLoading(true)
    try {
      const result = await sessionsApi.reflect(activeSession.id)
      toast.success(t('sessions_ui.sessions.reflected', { count: result.proposals_created }))
    } catch (e) { toast.error(errMsg(e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4 pb-4 border-b border-border">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'color-mix(in oklch, var(--primary) 12%, transparent)',
            border: '1px solid color-mix(in oklch, var(--primary) 35%, transparent)',
          }}
        >
          <MessageSquare className="size-5 text-accent-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('sessions_ui.sessions.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('sessions_ui.sessions.subtitle')}</p>
        </div>
      </div>

      <Card>
        <CardTitle>{t('sessions_ui.sessions.new')}</CardTitle>
        <p className="text-xs text-muted-foreground mb-3">
          {t('sessions_ui.sessions.viewing', { space: activeSpaceName ?? activeSpaceId ?? t('sessions_ui.sessions.no_space') })}
        </p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>{t('sessions_ui.sessions.title_optional')}</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('sessions_ui.sessions.title_placeholder')}
              onKeyDown={e => e.key === 'Enter' && createSession()}
            />
          </div>
          <ProjectFolderSelectors projectId={projectId} folderId={folder} onProjectChange={setProjectId} onFolderChange={setFolder} />
        </div>
        <Button onClick={createSession} disabled={!activeSpaceId}>{t('sessions_ui.sessions.create')}</Button>
      </Card>

      <Card>
        <CardTitle>{t('sessions_ui.sessions.list')}</CardTitle>
        {sessions.length === 0
          ? <p className="text-muted-foreground text-center py-10 text-sm">
              {activeSpaceId ? t('sessions_ui.sessions.empty') : t('sessions_ui.sessions.select_space')}
            </p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sessions_ui.sessions.col_title')}</TableHead>
                  <TableHead>{t('sessions_ui.sessions.col_status')}</TableHead><TableHead>{t('sessions_ui.sessions.col_created')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map(s => (
                  <TableRow key={s.id}>
                    <TableCell>{s.title ?? <span className="text-muted-foreground">{t('sessions_ui.sessions.untitled')}</span>}</TableCell>
                    <TableCell><StatusBadge status={s.status} /></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDateTime(s.created_at)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => openSession(s.id)}>{t('sessions_ui.sessions.open')}</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>

      {sessionNotFound && (
        <Card>
          <EmptyState
            title={t('sessions_ui.sessions.not_found')}
            description={t('sessions_ui.sessions.not_found_description')}
          />
        </Card>
      )}

      {!sessionNotFound && activeSession && (
        <Card>
          <CardTitle>{t('sessions_ui.sessions.session_title', { title: activeSession.title ?? t('sessions_ui.sessions.untitled') })}</CardTitle>
          <div className="flex flex-col gap-2.5 max-h-72 overflow-y-auto mb-4 pr-1">
            {messages.length === 0
              ? <p className="text-muted-foreground text-center py-6 text-sm">{t('sessions_ui.sessions.no_messages')}</p>
              : messages.map(m => (
                <div
                  key={m.id}
                  className={`px-3 py-2.5 rounded-lg max-w-[80%] text-sm ${
                    m.role === 'user'
                      ? 'self-end bg-primary/15 text-foreground'
                      : 'self-start bg-card border border-border'
                  }`}
                >
                  <span className="text-[11px] text-muted-foreground mr-2">{MESSAGE_ROLES.has(m.role) ? t(`sessions_ui.sessions.role.${m.role}`) : m.role}</span>
                  {m.content}
                </div>
              ))}
          </div>
          <Textarea
            value={msgInput}
            onChange={e => setMsgInput(e.target.value)}
            placeholder={t('sessions_ui.sessions.message_placeholder')}
            className="mb-3"
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                sendMessage()
              }
            }}
          />
          <div className="flex gap-2">
            <Button onClick={sendMessage} disabled={!msgInput.trim()}>{t('sessions_ui.sessions.send')}</Button>
            <Button variant="outline" onClick={reflect} disabled={loading}>
              {loading ? t('sessions_ui.sessions.reflecting') : t('sessions_ui.sessions.reflect')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}
