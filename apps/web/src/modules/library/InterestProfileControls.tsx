import { useAppTranslation } from '../../i18n'
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
  const { t } = useAppTranslation()
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
        <h3 className="text-sm font-semibold">{t('reading.profileTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('reading.profileHint')}</p>
      </div>

      {profile.ready_candidates.length > 0 && <div className="space-y-2">
        <p className="text-xs font-medium">{t('reading.suggestedTopics')}</p>
        {profile.ready_candidates.map(candidate => <div key={candidate.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{t('reading.candidateReads', { phrase: candidate.display_phrase, read: candidate.read_count, total: candidate.occurrence_count })}</span>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !candidate.domain_key} onClick={() => void run(
              () => informationDigestsApi.acceptCandidate(spaceId, candidate.phrase_key, {}), t('reading.topicAdded'),
            )}>{t('reading.accept')}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(
              () => informationDigestsApi.dismissCandidate(spaceId, candidate.phrase_key), t('reading.suggestionDismissed'),
            )}>{t('reading.dismissSuggestion')}</Button>
          </div>
        </div>)}
      </div>}

      <div className="space-y-2">
        <p className="text-xs font-medium">{t('reading.topics')}</p>
        {profile.topics.map(topic => <TopicEditor key={topic.id} {...{ spaceId, topic, domains: profile.domains, busy, run }} />)}
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input aria-label={t('reading.newTopicLabel')} placeholder={t('reading.newTopic')} value={label} onChange={event => setLabel(event.target.value)} />
          <Select ariaLabel={t('reading.newTopicDomain')} value={domainKey} onChange={setDomainKey}
            options={profile.domains.map(domain => ({ value: domain.key, label: domain.label }))} />
          <Button disabled={busy || !label.trim() || !domainKey} onClick={() => void run(async () => {
            await informationDigestsApi.createTopic(spaceId, { label: label.trim(), domain_key: domainKey, weight: 1 })
            setLabel('')
          }, t('reading.topicAdded'))}>{t('reading.addTopic')}</Button>
        </div>
      </div>

      {profile.topics.length === 0 && profile.starter_packs.length > 0 && <div className="space-y-2">
        <p className="text-xs font-medium">{t('reading.starterPacks')}</p>
        <div className="flex flex-wrap gap-2">{profile.starter_packs.map(pack => <Button key={pack.key} size="sm" variant="outline" disabled={busy} onClick={() => void run(
          () => informationDigestsApi.applyStarterPack(spaceId, pack.key), t('reading.packApplied', { name: pack.label }),
        )}>{pack.label}</Button>)}</div>
      </div>}

      <details className="space-y-3">
        <summary className="cursor-pointer text-xs font-medium">{t('reading.rankingSettings')}</summary>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SETTING_FIELDS.map(field => <label key={field.key} className="text-xs text-muted-foreground">{t(`reading.${field.key}`)}
            <Input type="number" min={field.min} max={field.max} value={settings[field.key]} onChange={event => setSettings(current => ({
              ...current, [field.key]: Number(event.target.value),
            }))} />
          </label>)}
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" disabled={busy} onClick={() => void run(
            () => informationDigestsApi.updateProfileSettings(spaceId, settings), t('reading.settingsSaved'),
          )}>{t('reading.saveSettings')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            await informationDigestsApi.backfillProfileHistory(spaceId)
          }, t('reading.historyChecked'))}>{t('reading.backfillHistory')}</Button>
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
  const { t } = useAppTranslation()
  const [label, setLabel] = useState(topic.label)
  const [domainKey, setDomainKey] = useState(topic.domain_key)
  const [weight, setWeight] = useState(topic.weight)
  return <div className="grid items-center gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_6rem_auto_auto]">
    <Input aria-label={t('reading.topicLabel', { name: topic.label })} value={label} onChange={event => setLabel(event.target.value)} />
    <Select ariaLabel={t('reading.topicDomain', { name: topic.label })} value={domainKey} onChange={setDomainKey}
      options={domains.map(domain => ({ value: domain.key, label: domain.label }))} />
    <Input aria-label={t('reading.topicWeight', { name: topic.label })} type="number" min={0} max={10} step={0.1} value={weight} onChange={event => setWeight(Number(event.target.value))} />
    <Button disabled={busy || !label.trim()} onClick={() => void run(
      () => informationDigestsApi.updateTopic(spaceId, topic.topic_key, { label: label.trim(), domain_key: domainKey, weight }), t('reading.topicSaved'),
    )}>{t('reading.saveTopic')}</Button>
    <Button variant="outline" disabled={busy} onClick={() => void run(
      () => informationDigestsApi.archiveTopic(spaceId, topic.topic_key), t('reading.topicArchived'),
    )}>{t('reading.archiveTopic')}</Button>
  </div>
}

const SETTING_FIELDS: Array<{ key: keyof InterestProfileSettings; min: number; max: number }> = [
  { key: 'interest_slots', min: 1, max: 20 },
  { key: 'serendipity_slots', min: 0, max: 10 },
  { key: 'coverage_half_life_days', min: 1, max: 3650 },
  { key: 'new_topic_occurrence_threshold', min: 1, max: 100 },
  { key: 'new_topic_read_threshold', min: 1, max: 100 },
  { key: 'warming_min_read_items', min: 1, max: 10000 },
  { key: 'warm_min_read_items', min: 1, max: 10000 },
  { key: 'warm_min_covered_domains', min: 1, max: 60 },
  { key: 'interesting_cooldown_days', min: 1, max: 365 },
  { key: 'neutral_cooldown_days', min: 1, max: 365 },
  { key: 'probe_domain_budget', min: 1, max: 3 },
]
