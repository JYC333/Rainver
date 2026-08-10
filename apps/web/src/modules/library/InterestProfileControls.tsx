import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { informationDigestsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'
import type { InterestProfileSettings, InterestProfileSnapshot } from '../../types/api'

export function InterestProfileControls({ spaceId, profile, onChanged }: {
  spaceId: string
  profile: InterestProfileSnapshot
  onChanged: () => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [domainKey, setDomainKey] = useState(profile.domains[0]?.key ?? '')
  const [settings, setSettings] = useState(profile.settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => setSettings(profile.settings), [profile.settings])

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true)
    try {
      await action()
      toast.success(message)
      await onChanged()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Your interest profile</h3>
        <p className="text-xs text-muted-foreground">Private to you. Topics affect familiar-item ranking; serendipity feedback never changes them.</p>
      </div>

      {profile.ready_candidates.length > 0 && <div className="space-y-2">
        <p className="text-xs font-medium">Suggested topics</p>
        {profile.ready_candidates.map(candidate => <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{candidate.display_phrase} · read {candidate.read_count}/{candidate.occurrence_count}</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !candidate.domain_key} onClick={() => void run(
              () => informationDigestsApi.acceptCandidate(spaceId, candidate.phrase_key, {}), 'Topic added',
            )}>Accept</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(
              () => informationDigestsApi.dismissCandidate(spaceId, candidate.phrase_key), 'Suggestion dismissed',
            )}>Dismiss</Button>
          </div>
        </div>)}
      </div>}

      <div className="space-y-2">
        <p className="text-xs font-medium">Topics</p>
        {profile.topics.map(topic => <TopicEditor key={topic.id} {...{ spaceId, topic, domains: profile.domains, busy, run }} />)}
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input aria-label="New interest topic" placeholder="New topic" value={label} onChange={event => setLabel(event.target.value)} />
          <Select ariaLabel="New topic domain" value={domainKey} onChange={setDomainKey}
            options={profile.domains.map(domain => ({ value: domain.key, label: domain.label }))} />
          <Button disabled={busy || !label.trim() || !domainKey} onClick={() => void run(async () => {
            await informationDigestsApi.createTopic(spaceId, { label: label.trim(), domain_key: domainKey, weight: 1 })
            setLabel('')
          }, 'Topic added')}>Add topic</Button>
        </div>
      </div>

      {profile.topics.length === 0 && profile.starter_packs.length > 0 && <div className="space-y-2">
        <p className="text-xs font-medium">Optional starter packs</p>
        <div className="flex flex-wrap gap-2">{profile.starter_packs.map(pack => <Button key={pack.key} size="sm" variant="outline" disabled={busy} onClick={() => void run(
          () => informationDigestsApi.applyStarterPack(spaceId, pack.key), `${pack.label} starter pack applied`,
        )}>{pack.label}</Button>)}</div>
      </div>}

      <details className="space-y-3">
        <summary className="cursor-pointer text-xs font-medium">Ranking and rotation settings</summary>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SETTING_FIELDS.map(field => <label key={field.key} className="text-xs text-muted-foreground">{field.label}
            <Input type="number" min={field.min} max={field.max} value={settings[field.key]} onChange={event => setSettings(current => ({
              ...current, [field.key]: Number(event.target.value),
            }))} />
          </label>)}
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" disabled={busy} onClick={() => void run(
            () => informationDigestsApi.updateProfileSettings(spaceId, settings), 'Profile settings saved',
          )}>Save settings</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            await informationDigestsApi.backfillProfileHistory(spaceId)
          }, 'History backfill checked')}>Backfill history</Button>
        </div>
      </details>
    </Card>
  )
}

function TopicEditor({ spaceId, topic, domains, busy, run }: {
  spaceId: string
  topic: InterestProfileSnapshot['topics'][number]
  domains: InterestProfileSnapshot['domains']
  busy: boolean
  run: (action: () => Promise<unknown>, message: string) => Promise<void>
}) {
  const [label, setLabel] = useState(topic.label)
  const [domainKey, setDomainKey] = useState(topic.domain_key)
  const [weight, setWeight] = useState(topic.weight)
  return <div className="grid gap-2 rounded border p-2 sm:grid-cols-[1fr_1fr_6rem_auto_auto]">
    <Input aria-label={`Topic label ${topic.label}`} value={label} onChange={event => setLabel(event.target.value)} />
    <Select ariaLabel={`Topic domain ${topic.label}`} value={domainKey} onChange={setDomainKey}
      options={domains.map(domain => ({ value: domain.key, label: domain.label }))} />
    <Input aria-label={`Topic weight ${topic.label}`} type="number" min={0} max={10} step={0.1} value={weight} onChange={event => setWeight(Number(event.target.value))} />
    <Button size="sm" disabled={busy || !label.trim()} onClick={() => void run(
      () => informationDigestsApi.updateTopic(spaceId, topic.topic_key, { label: label.trim(), domain_key: domainKey, weight }), 'Topic saved',
    )}>Save</Button>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(
      () => informationDigestsApi.archiveTopic(spaceId, topic.topic_key), 'Topic archived',
    )}>Archive</Button>
  </div>
}

const SETTING_FIELDS: Array<{ key: keyof InterestProfileSettings; label: string; min: number; max: number }> = [
  { key: 'interest_slots', label: 'Interest items', min: 1, max: 20 },
  { key: 'serendipity_slots', label: 'Serendipity items', min: 0, max: 10 },
  { key: 'coverage_half_life_days', label: 'Coverage half-life (days)', min: 1, max: 3650 },
  { key: 'new_topic_occurrence_threshold', label: 'Topic occurrence threshold', min: 1, max: 100 },
  { key: 'new_topic_read_threshold', label: 'Topic read threshold', min: 1, max: 100 },
  { key: 'warming_min_read_items', label: 'Warming read threshold', min: 1, max: 10000 },
  { key: 'warm_min_read_items', label: 'Warm read threshold', min: 1, max: 10000 },
  { key: 'warm_min_covered_domains', label: 'Warm domain threshold', min: 1, max: 60 },
  { key: 'interesting_cooldown_days', label: 'Interesting cooldown (days)', min: 1, max: 365 },
  { key: 'neutral_cooldown_days', label: 'Neutral cooldown (days)', min: 1, max: 365 },
  { key: 'probe_domain_budget', label: 'Weekly probe budget', min: 1, max: 10 },
]
