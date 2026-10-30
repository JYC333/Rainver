import type {SourceGoalDetail} from '@rainver/protocol'
import {useAppTranslation} from '../../i18n'
import {SpaceLink} from '../../core/spaceNav'
import {safeHttpUrl} from '../../lib/safeHttpUrl'

type Preview=SourceGoalDetail['previews'][number]
const reasonKeys:Record<string,string>={
 source_material_unavailable:'nativeFailed',source_material_failed:'nativeFailed',source_material_permission_denied:'nativeFailed',
 source_material_submission_missing:'nativeFailed',source_search_unavailable:'nativeFailed',source_search_failed:'nativeFailed',source_permission_denied:'nativeFailed',
 source_native_safety_unavailable:'nativeUnsupported',source_native_runtime_unsupported:'nativeUnsupported',source_native_deadline_exceeded:'previewTimeout',source_credential_decision_required:'previewCredential',source_native_evidence_unavailable:'nativeFailed',source_native_failed:'nativeFailed',source_native_output_invalid:'nativeFailed',source_native_route_changed:'nativeFailed',source_native_cancelled:'previewCancelled',
 source_credential_unavailable:'previewCredential',source_credential_invalid:'previewCredential',
 source_credential_scope_changed:'previewCredentialScope',source_search_query_unavailable:'previewQuery',
 source_quota_exhausted:'previewQuota',source_request_limit:'previewQuota',source_cooldown:'previewQuota',
 source_timeout:'previewTimeout',source_cancelled:'previewCancelled',
 source_network_failed:'previewNetwork',source_network_refused:'previewNetwork',source_upstream_refused:'previewUpstream',
 source_runner_disabled:'previewRunner',source_isolation_unavailable:'previewRunner',
 source_authority_revoked:'previewAuthority',source_policy_refused:'previewAuthority',source_scope_refused:'previewAuthority',
 source_parser_validation_failed:'previewInvalid',source_parser_failed:'previewInvalid',source_output_invalid:'previewInvalid',
 missing_identity_time_or_link:'previewIdentity',duplicate_stable_id:'previewInvalid',duplicate_source_uri:'previewInvalid',
 empty_result:'previewEmpty',
}
/** Localized reason key for a stable public Source failure code, if known. */
export function sourceFailureKey(code:string|null|undefined):string|undefined{return code?reasonKeys[code]:undefined}
/** Render only stable public failure codes, never arbitrary provider diagnostics. */
export function SourceGoalPreviewResult({preview,pending,sources}:{preview?:Preview;pending:boolean;sources:{source_connection_id:string;reason:string}[]}){
 const {t}=useAppTranslation();const text=(key:string)=>t(`sourceGoals.${key}`)
 if(pending)return <p role="status" aria-live="polite">{text('previewWorking')}</p>
 if(!preview)return <p>{text('previewNeeded')}</p>
 const expired=Date.parse(preview.expires_at)<=Date.now()
 return <>
  {preview.status==='running'?<p role="status">{text('previewWorking')}</p>:preview.status==='partial'?<p role="status">{text('partial')}</p>:null}
  {expired&&<p role="status">{text('previewExpired')}</p>}
  {preview.result_json.observed_at&&<p className="text-xs text-muted-foreground">{text('previewChecked')}: {new Date(preview.result_json.observed_at).toLocaleString()}</p>}
  {preview.result_json.contributions.map(c=>{
   const validation=c.validation as {errors?:unknown;filtered_count?:number}|undefined
   const errors=c.error?[c.error]:Array.isArray(validation?.errors)?validation.errors.filter((e):e is string=>typeof e==='string'):[]
   const messages=[...new Set(errors.map(e=>text(reasonKeys[e]??'previewRefused')))]
   const items=c.output?.items??[]
   return <section key={c.source_connection_id} className="space-y-2">
    <p className="font-medium text-sm">{sources.find(s=>s.source_connection_id===c.source_connection_id)?.reason??text('sourceSettings')}</p>
    {messages.map(message=><p key={message} role="status" className="text-sm">{message}</p>)}
    {!items.length&&!messages.length&&<p role="status" className="text-sm">{text('previewEmpty')}</p>}
    {typeof validation?.filtered_count==='number'&&validation.filtered_count>0&&<p className="text-xs text-muted-foreground">{t('sourceGoals.previewFiltered',{count:validation.filtered_count})}</p>}
    {c.status!=='succeeded'&&<SpaceLink className="text-sm underline" to={`/sources/${c.source_connection_id}`}>{text('sourceSettings')}</SpaceLink>}
    {items.map(i=><article key={i.external_id} className="space-y-1 border-t border-border py-3"><a className="font-medium underline" href={safeHttpUrl(i.source_uri)??undefined} target="_blank" rel="noreferrer">{i.title}</a><p className="text-xs text-muted-foreground">{i.published_at?new Date(i.published_at).toLocaleString():text('unknownTime')}</p>{i.excerpt&&<p className="text-sm">{i.excerpt}</p>}{(c.coverage as {verification?:string}|undefined)?.verification==='agent_provided_unverified'&&<p className="text-xs text-muted-foreground">{i.reading_content?t('reading.materialPreparedPreview'):t('reading.materialLinkOnlyPreview')}</p>}</article>)}
   </section>
  })}
 </>
}
