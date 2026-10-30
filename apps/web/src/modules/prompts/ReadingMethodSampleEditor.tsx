import { Card } from '../../components/ui/card';
import { useAppTranslation } from '../../i18n';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { evidenceSample } from './readingMethodApi';
/** User-provided, bounded evidence. Saving a case neither fetches a URL nor calls a model. */
export function ReadingMethodSampleEditor({
  busy,
  save
}: {
  busy: boolean;
  save: (sample: typeof evidenceSample) => void;
}) {
  const {
    t
  } = useAppTranslation();
  const [name, setName] = useState(evidenceSample.name);
  const [pages, setPages] = useState(evidenceSample.pages.map(p => ({
    ...p
  })));
  return <Card className="p-3"><details className="space-y-3">
  <summary className="cursor-pointer">{t('readingMethod.custom_controlled_evidence_sample_no_fetch')}</summary>
  <p className="text-sm text-muted-foreground">{t('readingMethod.custom_text_must_be_exact_excerpts_of')}</p>
  <label className="block">{t('readingMethod.sample_name')}<Input disabled={busy} value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label>
  {pages.map((page, index) => <fieldset className="space-y-2 rounded border border-border p-3" key={index}>
   <legend>{index === 0 ? t('readingMethod.homepage') : t('readingMethod.documentation_example')}</legend>
   <label className="block">URL<Input disabled={busy} type="url" maxLength={2048} value={page.url} onChange={e => setPages(v => v.map((p, n) => n === index ? {
            ...p,
            url: e.target.value
          } : p))} /></label>
   <label className="block">{t('readingMethod.text_actually_read')}<Textarea disabled={busy} className="min-h-32" maxLength={8000} value={page.text} onChange={e => setPages(v => v.map((p, n) => n === index ? {
            ...p,
            text: e.target.value
          } : p))} /></label>
  </fieldset>)}
  <Button variant="outline" disabled={busy || !name.trim() || pages.some(p => !p.text.trim() || !/^https?:\/\//.test(p.url))} onClick={() => save({
        name,
        pages
      })}>{t('readingMethod.save_and_select_this_sample')}</Button>
 </details></Card>;
}
