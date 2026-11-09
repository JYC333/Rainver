import { useEffect, useState } from 'react';
import type { PluginSlotContext } from '../modules/plugins/slotTypes';
function Records({
  ctx
}: {
  ctx: PluginSlotContext;
}) {
  const {
      ops,
      ui
    } = ctx,
    {
      Button,
      Input,
      Card,
      CardHeader,
      CardTitle,
      CardContent,
      t
    } = ui;
  const [values, setValues] = useState<string[]>([]),
    [value, setValue] = useState(''),
    [proposal, setProposal] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    const result = await ops.query<{
      values: string[];
    }>('plugin.operation_probe.record.list', {});
    if ('status' in result && result.status === 'succeeded') setValues(result.data.values);
  };
  useEffect(() => {
    void refresh().catch(() => {});
  }, [ops]);
  const execute = async (verb: 'write' | 'propose' | 'enqueue') => {
    setBusy(true);
    setNotice('');
    try {
      const result = await ops.command('plugin.operation_probe.record.' + verb as `plugin.${string}.${string}.${string}`, {
        value
      }, crypto.randomUUID());
      if ('error' in result) throw new Error(result.error.message);
      if ('status' in result && result.status === 'pending_approval') {
        setProposal(result.proposal_id);
        setNotice(t('plugin_ui.pending'));
      } else {
        setNotice(t(verb === 'enqueue' ? 'plugin_ui.queued' : 'plugin_ui.saved'));
        await refresh();
      }
    } catch {
      setNotice(t('plugin_ui.error'));
    } finally {
      setBusy(false);
    }
  };
  return <Card><CardHeader><CardTitle>{t('plugin_ui.records')}</CardTitle></CardHeader><CardContent className="space-y-4">
  <label className="block space-y-2 text-sm"><span>{t('plugin_ui.value')}</span><Input className="max-md:min-h-[44px]" value={value} onChange={e => setValue(e.target.value)} /></label>
  <div className="flex flex-wrap gap-2"><Button className="max-md:min-h-[44px]" disabled={busy} onClick={() => void execute('write')}>{t('plugin_ui.save')}</Button><Button className="max-md:min-h-[44px]" variant="outline" disabled={busy} onClick={() => void execute('propose')}>{t('plugin_ui.propose')}</Button><Button className="max-md:min-h-[44px]" variant="outline" disabled={busy} onClick={() => void execute('enqueue')}>{t('plugin_ui.background')}</Button><Button className="max-md:min-h-[44px]" variant="ghost" onClick={() => void refresh().catch(error => {
          if (error.name !== 'AbortError') setNotice(t('plugin_ui.error'));
        })}>{t('plugin_ui.refresh')}</Button></div>
  {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
  {proposal && <ui.ProposalLink id={proposal} />}
  {values.length ? <ul className="space-y-2 text-sm">{values.map((v, i) => <li key={i} className="break-words rounded-md bg-muted p-3">{v}</li>)}</ul> : <p className="text-sm text-muted-foreground">{t('plugin_ui.empty')}</p>}
 </CardContent></Card>;
}
export default {
  records: Records
};
