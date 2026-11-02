import { useEffect, useRef, useState } from 'react';
import { providersApi,readingMethodsApi } from '../../api/client';
import { Select } from '../../components/ui/select';
import { useAppTranslation } from '../../i18n';
import { SpaceLink } from '../../core/spaceNav';
import { Button } from '../../components/ui/button';
import { registerInMemoryResidue, sessionEpoch } from '../../lib/sessionResidue';
export interface MethodExecution {
  agent_id?: string;
  runtime_profile_id?: string;
  provider_id?: string;
  model?: string;
}
export function ReadingMethodApiExecution({
  value,
  onChange,
  disabled,
  projectId
}: {
  projectId?:string|null;
  value: MethodExecution;
  onChange: (v: MethodExecution) => void;
  disabled: boolean;
}) {
  const {
    t
  } = useAppTranslation();
  const [options, setOptions] = useState<Array<{
    id: string;
    name: string;
    models: string[];
  }>>([]);
  const [mode,setMode]=useState(value.agent_id?'cli':value.provider_id?'api':'default');
  const [cli,setCli]=useState<Array<{agent_id:string;runtime_profile_id:string;name:string}>>([]);
  const [cliError,setCliError]=useState(false);
  useEffect(()=>{
   if(mode!=='cli')return;
   let live=true;const epoch=sessionEpoch();const drop=registerInMemoryResidue(()=>{live=false;setCli([]);});
   void readingMethodsApi.cliOptions(projectId).then(rows=>{if(live&&epoch===sessionEpoch()){setCli(rows);setCliError(false);}}).catch(()=>{if(live&&epoch===sessionEpoch()){setCli([]);setCliError(true);}});
   return ()=>{live=false;drop();};
  },[mode,projectId]);
  const owner = useRef<object | null>(null);
  useEffect(() => {
    const token = {};
    owner.current = token;
    const epoch = sessionEpoch();
    const drop = registerInMemoryResidue(() => {
      owner.current = null;
      setOptions([]);
    });
    void providersApi.usable().then(rows => {
      if (owner.current === token && epoch === sessionEpoch()) setOptions(rows.map(p => ({
        id: p.id,
        name: p.name,
        models: [...new Set([p.default_model, ...p.available_models].filter((s): s is string => !!s))]
      })));
    }).catch(() => {
      if (owner.current === token) setOptions([]);
    });
    return () => {
      owner.current = null;
      drop();
    };
  }, []);
  return <section className="space-y-3 border-t border-border pt-4"><h2 className="font-semibold">{t('readingMethod.api_execution')}</h2><p className="text-muted-foreground">{t('readingMethod.api_execution_help')}</p><Select portal={false} ariaLabel={t('readingMethod.execution_mode')} disabled={disabled} value={mode} onChange={mode=>{setMode(mode);onChange(mode==='cli'?{agent_id:'',runtime_profile_id:''}:{});}} options={[{value:'default',label:t('readingMethod.api_default')},{value:'api',label:t('readingMethod.other_api')},{value:'cli',label:t('readingMethod.cli_execution')}]} />
    {mode==='cli'?<><p className="text-sm text-muted-foreground">{t('readingMethod.cli_help')}</p><Select portal={false} ariaLabel={t('readingMethod.cli_execution')} disabled={disabled} value={value.runtime_profile_id??''} onChange={id=>{const selected=cli.find(c=>c.runtime_profile_id===id);onChange(selected?{agent_id:selected.agent_id,runtime_profile_id:id}:{agent_id:'',runtime_profile_id:''});}} options={[{value:'',label:t('readingMethod.choose_cli')},...cli.map(c=>({value:c.runtime_profile_id,label:c.name}))]}/>{!cli.length&&<p role="status">{t(cliError?'readingMethod.cli_load_error':'readingMethod.cli_empty')} <Button size="sm" variant="ghost" asChild><SpaceLink to="/command-center">{t('readingMethod.cli_setup')}</SpaceLink></Button></p>}</>:mode==='api'&&<><Select portal={false} ariaLabel={t('readingMethod.api_provider')} disabled={disabled} value={value.provider_id ?? ''} onChange={id => onChange({
      provider_id: id || undefined
    })} options={[{
      value: '',
      label: t('readingMethod.api_default')
    }, ...options.map(p => ({
      value: p.id,
      label: p.name
    }))]} />{value.provider_id && <Select portal={false} ariaLabel={t('readingMethod.api_model')} disabled={disabled} value={value.model ?? ''} onChange={model => onChange({
      ...value,
      model: model || undefined
    })} options={[{
      value: '',
      label: t('readingMethod.api_default_model')
    }, ...(options.find(p => p.id === value.provider_id)?.models ?? []).map(model => ({
      value: model,
      label: model
    }))]} />}</>}<Button size="sm" variant="ghost" asChild><SpaceLink to="/providers">{t('readingMethod.configure_api')}</SpaceLink></Button></section>;
}
