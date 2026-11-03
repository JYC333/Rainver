import {useState,type ComponentProps,type ReactNode} from 'react'
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '../../../components/ui/dialog'
import {Tabs,TabsList,TabsTrigger,TabsContent} from '../../../components/ui/tabs'
import {useAppTranslation} from '../../../i18n'
import {SourceGoalWorkbench} from '../SourceGoalWorkbench'
import {TopicEditor} from './TopicEditor'

/** One scoped adjustment surface; closing does not apply or cancel a plan. */
export function TopicAdjustmentDialog({onClose,onSaved,planning,confirmation,returnFocus,...workbench}:ComponentProps<typeof SourceGoalWorkbench>&{onClose:()=>void;onSaved:()=>void;planning:boolean;confirmation:ReactNode;returnFocus:()=>void}){
 const {t}=useAppTranslation()
 // Freeze the form's expected revision. A polling refresh must not silently
 // rebase unsaved edits onto a different version.
 const [editingDetail]=useState(workbench.detail)
 const editable=!!editingDetail.versions.length&&!planning
 const [mode,setMode]=useState(editable?'edit':'discuss'),[saving,setSaving]=useState(false)
 return <Dialog open onOpenChange={open=>{if(!open&&!saving)onClose()}}><DialogContent onCloseAutoFocus={event=>{event.preventDefault();returnFocus()}} showClose={!saving} className="flex h-dvh max-h-dvh max-w-none flex-col overflow-hidden rounded-none p-4 sm:h-[85dvh] sm:max-h-[92dvh] sm:max-w-4xl sm:rounded-lg sm:p-6">
  <DialogHeader className="mb-3 shrink-0 pr-6"><DialogTitle>{t('topics.adjust')}</DialogTitle><DialogDescription>{t('topics.adjustHint')}</DialogDescription></DialogHeader>
  <div className="max-h-[35%] shrink-0 overflow-y-auto">{confirmation}</div>
  <Tabs value={mode} onValueChange={setMode} className="flex min-h-0 flex-1 flex-col gap-3">
   <TabsList className="shrink-0 self-start"><TabsTrigger value="edit" disabled={!editable||saving}>{t('topics.directEdit')}</TabsTrigger><TabsTrigger value="discuss" disabled={saving}>{t('topics.discuss')}</TabsTrigger></TabsList>
   <TabsContent forceMount value="edit" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
    <p className="mb-4 shrink-0 text-sm text-muted-foreground">{t('topics.editHint')}</p>
    <TopicEditor detail={editingDetail} spaceId={workbench.spaceId} onClose={onClose} onSaved={onSaved} onSaving={setSaving}/>
   </TabsContent>
   <TabsContent forceMount value="discuss" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><SourceGoalWorkbench {...workbench}/></TabsContent>
  </Tabs>
 </DialogContent></Dialog>
}
