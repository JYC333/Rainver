import { Card } from '../../components/ui/card';
import { useAppTranslation } from '../../i18n';
import { useEffect, useState } from 'react';
import { useSpace } from '../../contexts/SpaceContext';
import { sessionEpoch, registerInMemoryResidue } from '../../lib/sessionResidue';
import { readingMethodsApi } from './readingMethodApi';
export function ReadingMethodSamplePreview({
  sampleId
}: {
  sampleId: string;
}) {
  const {
    t
  } = useAppTranslation();
  const {
    activeSpaceId,
    userId
  } = useSpace();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<{
      key: string;
      epoch: number;
      pages: Array<{
        url: string;
        text: string;
      }>;
    } | null>(null),
    [error, setError] = useState(false);
  const key = `${activeSpaceId}:${userId}:${sampleId}`;
  useEffect(() => {
    let live = true;
    const epoch = sessionEpoch();
    setShown(null);
    setError(false);
    const drop = registerInMemoryResidue(() => setShown(null));
    if (open && sampleId) void readingMethodsApi.readSample(sampleId).then(r => {
      if (live && sessionEpoch() === epoch) setShown({
        key,
        epoch,
        pages: r.pages
      });
    }, () => {
      if (live && sessionEpoch() === epoch) setError(true);
    });
    return () => {
      live = false;
      drop();
    };
  }, [key, sampleId, open]);
  const pages = shown?.key === key && shown.epoch === sessionEpoch() ? shown.pages : null;
  return <Card className="p-3"><details onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer">{t('readingMethod.inspect_the_selected_sample_input')}</summary>{!sampleId ? <p>{t('readingMethod.choose_a_sample_first')}</p> : error ? <p role="alert">{t('readingMethod.sample_unavailable_refresh_or_prepare_it_again')}</p> : pages ? pages.map((p, index) => <section key={index} className="my-3 rounded border border-border p-3"><p className="break-all text-sm">{p.url}</p><p className="whitespace-pre-wrap break-words text-sm">{p.text}</p></section>) : <p>{t('readingMethod.loading')}</p>}</details></Card>;
}
