import type {ProjectThemeAnalysisSelection} from '@rainver/protocol'
import {AgentExecutionPicker} from '../../../components/agents/AgentExecutionPicker'
import {useAppTranslation} from '../../../i18n'
/** Included in the same exact-version Following confirmation, never a GET side effect. */
export function ThemeConsentFields({space,user,value,onChange,disabled}:{space:string;user:string;value?:ProjectThemeAnalysisSelection;onChange:(v:ProjectThemeAnalysisSelection|undefined)=>void;disabled:boolean}){
 const {t}=useAppTranslation();return <div role="group" aria-label={t('projectReading.analysisSettings')} className="space-y-3 rounded-lg border border-border bg-card p-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!!value?.enabled} disabled={disabled} onChange={e=>onChange(e.target.checked?{enabled:true}:undefined)}/>{t('projectReading.analysisConfirm')}</label><p className="text-xs text-muted-foreground">{t('projectReading.analysisConsent')}</p>{value?.enabled&&<AgentExecutionPicker spaceId={space} userId={user} value={{agent_id:value.agent_id??'',runtime_profile_id:value.runtime_profile_id??'',session_config:value.session_config}} onChange={v=>onChange({enabled:true,...v})} disabled={disabled}/>}</div>
}
