import { useState } from 'react'
import type { ReadingItem } from '@rainver/protocol'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { Input } from '../../components/ui/input'
import { useAppTranslation } from '../../i18n'
import { useReading } from '../library/useReading'
import { ReadingError } from '../library/ReadingError'

/** Material selection belongs to comparison, never to method maintenance admission. */
export function ReadingMethodComparisonExample({ spaceId, projectId, disabled, select }: {
  spaceId: string; projectId: string | null; disabled: boolean; select: (item: ReadingItem) => void
}) {
  const { t } = useAppTranslation()
  const [q, setQ] = useState(''), [draft, setDraft] = useState(''), [selected, setSelected] = useState('')
  const feed = useReading(spaceId, projectId ?? undefined, 'all', q, 30)
  const items = (feed.page?.items ?? []).filter(item => item.access_level === 'full' && (item.material_project_id === null || item.material_project_id === projectId))
  const item = !feed.loading && !feed.error ? items.find(item => item.key === selected) : undefined
  return <section className="space-y-3">
    <p className="text-sm text-muted-foreground">{t('readingMethod.comparison_example_hint')}</p>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setQ(draft.trim()); setSelected('') }}>
      <Input aria-label={t('reading.search')} value={draft} onChange={event => setDraft(event.target.value)} maxLength={500}/>
      <Button type="submit" variant="outline">{t('reading.searchSubmit')}</Button>
    </form>
    {feed.error != null && <ReadingError error={feed.error} retry={() => void feed.reload()}/>}
    <Select ariaLabel={t('readingMethod.example')} disabled={feed.loading || disabled} value={selected} onChange={setSelected}
      options={[{value:'',label:t('readingMethod.choose_a_sample_first')},...items.map(item => ({value:item.key,label:item.title}))]}/>
    {feed.page?.next_cursor && <Button variant="ghost" disabled={feed.loading} onClick={() => void feed.more()}>{t('reading.more')}</Button>}
    <Button disabled={disabled || !item} onClick={() => { if (item) select(item) }}>{t('readingMethod.use_comparison_example')}</Button>
  </section>
}
