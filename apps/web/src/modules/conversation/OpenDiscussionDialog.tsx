import { useEffect, useState } from 'react'
import {
  ROOM_DISCUSSION_DEFAULT_ROUND_CAP,
  ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD,
  ROOM_DISCUSSION_MAX_PARTICIPANTS,
  ROOM_DISCUSSION_MAX_ROUNDS,
} from '@rainver/protocol'
import { Button } from '../../components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { errMsg } from '../../lib/utils'
import { useAppTranslation } from '../../i18n'
import type { OpenRoomDiscussionRequest, RoomDiscussionShape } from '../../types/api'

/**
 * Opening a discussion among the Room's Agents.
 *
 * The person decides the bounds once, here: who takes part, whether the first
 * round answers independently (debate), how many rounds, and optionally a
 * spend cap. "All Agents" is a participant option rather than a token typed in
 * a message; the server expands it, and it is refused here
 * too when the Room has more active Agents than one discussion seats.
 */
export function OpenDiscussionDialog({
  open,
  agents,
  onClose,
  onSubmit,
}: {
  open: boolean
  /** The Room's active Agents. */
  agents: ReadonlyArray<{ id: string; name: string }>
  onClose: () => void
  /** Resolves when the discussion is open; a rejection keeps the dialog open with the reason. */
  onSubmit: (request: OpenRoomDiscussionRequest) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [topic, setTopic] = useState('')
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [shape, setShape] = useState<RoomDiscussionShape>('open')
  const [roundCap, setRoundCap] = useState(String(ROOM_DISCUSSION_DEFAULT_ROUND_CAP.open))
  const [roundCapEdited, setRoundCapEdited] = useState(false)
  const [spendCap, setSpendCap] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTopic('')
    setAll(false)
    setSelected([])
    setShape('open')
    setRoundCap(String(ROOM_DISCUSSION_DEFAULT_ROUND_CAP.open))
    setRoundCapEdited(false)
    setSpendCap('')
    setError(null)
  }, [open])

  function chooseShape(next: RoomDiscussionShape) {
    setShape(next)
    if (!roundCapEdited) setRoundCap(String(ROOM_DISCUSSION_DEFAULT_ROUND_CAP[next]))
  }

  function validate(): OpenRoomDiscussionRequest | string {
    const trimmed = topic.trim()
    if (!trimmed) return t('conversation_ui.open_discussion.need_topic')
    const count = all ? agents.length : selected.length
    if (count === 0) return t('conversation_ui.open_discussion.need_agent')
    if (count > ROOM_DISCUSSION_MAX_PARTICIPANTS) {
      return all
        ? t('conversation_ui.open_discussion.too_many_all', { count, max: ROOM_DISCUSSION_MAX_PARTICIPANTS })
        : t('conversation_ui.open_discussion.too_many_selected', { count, max: ROOM_DISCUSSION_MAX_PARTICIPANTS })
    }
    const rounds = Number(roundCap)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROOM_DISCUSSION_MAX_ROUNDS) {
      return t('conversation_ui.open_discussion.rounds_invalid', { max: ROOM_DISCUSSION_MAX_ROUNDS })
    }
    const spend = spendCap.trim() ? Number(spendCap) : null
    if (spend !== null && (!Number.isFinite(spend) || spend <= 0 || spend > 1000)) {
      return t('conversation_ui.open_discussion.spend_invalid')
    }
    return {
      topic: trimmed,
      participant_agent_ids: all ? 'all' : selected,
      shape,
      round_cap: rounds,
      ...(spend !== null ? { spend_cap_usd: spend } : {}),
    }
  }

  async function submit() {
    const request = validate()
    if (typeof request === 'string') {
      setError(request)
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit(request)
    } catch (submitError) {
      setError(errMsg(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !submitting) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('conversation_ui.open_discussion.title')}</DialogTitle>
          <DialogDescription>
            {t('conversation_ui.open_discussion.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Textarea
            aria-label={t('conversation_ui.open_discussion.topic')}
            placeholder={t('conversation_ui.open_discussion.topic_placeholder')}
            rows={3}
            value={topic}
            onChange={event => setTopic(event.target.value)}
          />
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('conversation_ui.open_discussion.participants')}</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} />
              {t('conversation_ui.open_discussion.all_agents')}
            </label>
            {agents.map(agent => (
              <label key={agent.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={all}
                  checked={all || selected.includes(agent.id)}
                  onChange={event => setSelected(current => event.target.checked
                    ? [...current, agent.id]
                    : current.filter(id => id !== agent.id))}
                />
                <span className="truncate">{agent.name}</span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('conversation_ui.open_discussion.shape')}</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="discussion-shape" checked={shape === 'open'} onChange={() => chooseShape('open')} />
              {t('conversation_ui.open_discussion.shape_open')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="discussion-shape" checked={shape === 'debate'} onChange={() => chooseShape('debate')} />
              {t('conversation_ui.open_discussion.shape_debate')}
            </label>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('conversation_ui.open_discussion.rounds')}</span>
              <Input
                type="number"
                min={1}
                max={ROOM_DISCUSSION_MAX_ROUNDS}
                value={roundCap}
                onChange={event => {
                  setRoundCap(event.target.value)
                  setRoundCapEdited(true)
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">{t('conversation_ui.open_discussion.spend_cap')}</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder={t('conversation_ui.open_discussion.spend_default', { amount: ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD.toFixed(2) })}
                value={spendCap}
                onChange={event => setSpendCap(event.target.value)}
              />
            </label>
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={submitting}>{t('conversation_ui.open_discussion.cancel')}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={submitting}>
            {submitting ? t('conversation_ui.open_discussion.opening') : t('conversation_ui.open_discussion.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
