import {useAppTranslation} from '../../i18n'
export function AgentSearchProvenance({value}:{value:unknown}){
 const {t}=useAppTranslation()
 return value==='agent_provided_unverified'?<p className="text-xs text-muted-foreground">{t('reading.agentProvidedUnverified')}</p>:null
}
