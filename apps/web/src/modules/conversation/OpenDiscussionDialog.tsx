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
    if (!trimmed) return 'Say what the discussion is about.'
    const count = all ? agents.length : selected.length
    if (count === 0) return 'Choose at least one Agent.'
    if (count > ROOM_DISCUSSION_MAX_PARTICIPANTS) {
      return all
        ? `This Room has ${count} active Agents; a discussion seats at most ${ROOM_DISCUSSION_MAX_PARTICIPANTS}. Choose up to ${ROOM_DISCUSSION_MAX_PARTICIPANTS}.`
        : `${count} Agents are selected; a discussion seats at most ${ROOM_DISCUSSION_MAX_PARTICIPANTS}.`
    }
    const rounds = Number(roundCap)
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROOM_DISCUSSION_MAX_ROUNDS) {
      return `Rounds must be a whole number from 1 to ${ROOM_DISCUSSION_MAX_ROUNDS}.`
    }
    const spend = spendCap.trim() ? Number(spendCap) : null
    if (spend !== null && (!Number.isFinite(spend) || spend <= 0 || spend > 1000)) {
      return 'The spend cap must be more than $0 and at most $1000.'
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
          <DialogTitle>Open a discussion</DialogTitle>
          <DialogDescription>
            The Agents reply to each other until nobody addresses anyone, the round cap is reached, or you stop it.
            The Manager then writes the conclusion.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Textarea
            aria-label="Topic"
            placeholder="What should they discuss?"
            rows={3}
            value={topic}
            onChange={event => setTopic(event.target.value)}
          />
          <fieldset className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Participants</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} />
              All Agents
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
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Shape</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="discussion-shape" checked={shape === 'open'} onChange={() => chooseShape('open')} />
              Open — each round sees the replies so far
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="discussion-shape" checked={shape === 'debate'} onChange={() => chooseShape('debate')} />
              Debate — the first round answers independently
            </label>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">Rounds</span>
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
              <span className="block text-xs font-medium text-muted-foreground">Spend cap (USD, optional)</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder={`$${ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD.toFixed(2)} (default)`}
                value={spendCap}
                onChange={event => setSpendCap(event.target.value)}
              />
            </label>
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Opening…' : 'Open discussion'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
