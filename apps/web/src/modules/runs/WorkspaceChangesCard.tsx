import {useMemo} from 'react'
import type {Run} from '../../types/api'
import {Button} from '../../components/ui/button'
import {useConversationScope} from '../conversation/ConversationScope'
import {useAppTranslation} from '../../i18n'
import {WorkspaceChangeList} from './WorkspaceChangeList'
import {useRunWorkspaceChanges} from './useRunWorkspaceChanges'

/** Run detail: every batch bound to this Run, with its full history and commands. */
export function WorkspaceChangesCard({run}:{run:Run}){
 const {t}=useAppTranslation(),scope=useConversationScope()
 const runs=useMemo(()=>[run],[run])
 const {entries,error,loaded,reload,enabled}=useRunWorkspaceChanges(runs,scope)
 if(!enabled)return null
 return <section className="min-w-0 space-y-3" data-testid={`workspace-changes-${run.id}`}>
  <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{t('workspace_ui.execution.title')}</p><Button size="sm" variant="ghost" onClick={reload}>{t('workspace_ui.execution.refresh')}</Button></div>
  <p className="mt-1 text-xs text-muted-foreground">{t('workspace_ui.execution.isolation')}</p>
  {error&&<p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
  {!error&&loaded&&entries.length===0&&<p className="mt-2 text-xs text-muted-foreground">{t('workspace_ui.execution.preparing')}</p>}
  <WorkspaceChangeList entries={entries} onChanged={reload}/>
 </section>
}
