import {useLocation} from 'react-router-dom';
import { useEffect, useId, useRef } from 'react';
import type { ReadingMethodContext } from '@rainver/protocol';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { SpaceLink } from '../../core/spaceNav';
import { useAppTranslation } from '../../i18n';

interface Props {
  data: ReadingMethodContext;
  execution?:React.ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  editRequest: number;
  editing: boolean;
  disabled: boolean;
  method: string;
  reason: string;
  setMethod: (method: string) => void;
  setReason: (reason: string) => void;
  startEditing: () => void;
  cancelEditing: () => void;
  save: () => void;
}

/** Viewing provenance is independent of entering the immutable-child editor. */
export function ReadingMethodAdvanced({ data, execution, open, onOpen, editRequest, editing, disabled, method, reason, setMethod, setReason, startEditing, cancelEditing, save }: Props) {
  const { t } = useAppTranslation();
  const location=useLocation();const next=new URLSearchParams(location.search);next.set("target_key",data.target_key==='prompt.revision.method'?'reading.project_investigation':'prompt.revision.method');
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && open) {
      editor.current?.focus();
      editor.current?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    }
  }, [editing, open, editRequest]);
  return <Card className="mb-0 p-4">
    <details open={open} onToggle={event => onOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('readingMethod.advanced')}</summary>
      <div className="mt-4 space-y-5">
        {data.can_manage&&execution}
        {data.revision_method&&<p className="text-xs text-muted-foreground">{t('readingMethod.revision_method')} · v{data.revision_method.version}</p>}
        <Button variant="outline" size="sm" asChild><SpaceLink to={`${location.pathname}?${next.toString()}`}>{t(data.target_key==='prompt.revision.method'?'readingMethod.back_target_method':'readingMethod.improve_revision_method')}</SpaceLink></Button>
        {data.can_manage && <section aria-labelledby={`${id}-manual`} className="space-y-3">
          <h2 id={`${id}-manual`} className="font-semibold">{t('readingMethod.manual_editing')}</h2>
          <p className="text-sm text-muted-foreground">{t('readingMethod.manual_editing_notice')}</p>
          {!editing ? <Button size="sm" variant="outline" disabled={disabled || !data.initialized} onClick={startEditing}>{t('readingMethod.edit_manually')}</Button> : <div className="space-y-4">
            <label className="block space-y-2"><span>{t('readingMethod.problem_reason_for_change')}</span><Input disabled={disabled} value={reason} maxLength={1200} onChange={e => setReason(e.target.value)} /></label>
            <label className="block space-y-2"><span>{t('readingMethod.reading_method')}</span><Textarea ref={editor} aria-label={t('readingMethod.reading_method')} disabled={disabled} className="min-h-72" value={method} maxLength={12000} onChange={e => setMethod(e.target.value)} /></label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={disabled || !reason.trim() || method.trim().length < 40} onClick={save}>{t('readingMethod.save_draft_production_unchanged')}</Button>
              <Button variant="ghost" disabled={disabled} onClick={cancelEditing}>{t('readingMethod.cancel_manual_edit')}</Button>
            </div>
          </div>}
        </section>}
        {data.result_provenance && <section aria-labelledby={`${id}-source`} className="space-y-2 border-t border-border pt-4">
          <h2 id={`${id}-source`} className="font-semibold">{t('readingMethod.technical_source_information')}</h2>
          <dl className="space-y-1 text-sm text-muted-foreground"><dt>{t('readingMethod.result_version')}</dt><dd className="break-all">v{data.result_provenance.version} · {data.result_provenance.version_id}</dd></dl>
          {data.result_provenance.run_id && <Button size="sm" variant="ghost" asChild><SpaceLink to={`/runs/${data.result_provenance.run_id}`}>{t('readingMethod.view_originating_run')}</SpaceLink></Button>}
        </section>}
        <section aria-labelledby={`${id}-management`} className="space-y-2 border-t border-border pt-4">
          <h2 id={`${id}-management`} className="font-semibold">{t('readingMethod.advanced_prompt_management')}</h2>
          <p className="text-sm text-muted-foreground">{t('readingMethod.asset_resolution_deployment_history_and_other_capabilities')}</p>
          <Button size="sm" variant="outline" asChild><SpaceLink to={`/prompts?advanced=1&asset=${encodeURIComponent(data.target_key??'reading.project_investigation')}`}>{t('readingMethod.open_advanced_workspace')}</SpaceLink></Button>
        </section>
      </div>
    </details>
  </Card>;
}
