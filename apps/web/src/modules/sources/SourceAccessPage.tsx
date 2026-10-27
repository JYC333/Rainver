import {useEffect,useRef,useState} from 'react'
import {useSpace} from '../../contexts/SpaceContext'
import {useAppTranslation} from '../../i18n'
import {SpaceLink} from '../../core/spaceNav'
import {sourceGoalsApi} from '../../api/client'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {Input} from '../../components/ui/input'

/** Dedicated existing encrypted credential channel; never a conversation input. */
export default function SourceAccessPage() {
  const {activeSpaceId,spaces}=useSpace()
  const {t}=useAppTranslation()
  const [name,setName]=useState('')
  const [secret,setSecret]=useState('')
  const [busy,setBusy]=useState(false)
  const [saved,setSaved]=useState(false)
  const [error,setError]=useState(false)
  const scope=useRef(activeSpaceId);scope.current=activeSpaceId
  useEffect(()=>{setName('');setSecret('');setSaved(false);setError(false)},[activeSpaceId])
  const admin=spaces.some(s=>s.id===activeSpaceId&&['owner','admin'].includes(s.role))
  return <Card className="m-4 max-w-xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">{t('sourceGoals.credentials')}</h1>
    <p>{t('sourceGoals.secureHint')}</p>
    {!admin ? <p role="alert">{t('sourceGoals.adminHelp')}</p> :
      <form className="space-y-4" onSubmit={async e=>{
        e.preventDefault()
        if(!activeSpaceId||busy)return
        setBusy(true);setError(false);setSaved(false)
        try {
          await sourceGoalsApi.storeCredential({name,secret},{spaceId:activeSpaceId})
          if(scope.current===activeSpaceId){setSecret('');setSaved(true)}
        } catch {if(scope.current===activeSpaceId)setError(true)} finally {setBusy(false)}
      }}>
        <label className="block">{t('sourceGoals.credentialName')}<Input required value={name} onChange={e=>setName(e.target.value)}/></label>
        <label className="block">{t('sourceGoals.credentialSecret')}<Input required type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/></label>
        <Button disabled={busy}>{t('sourceGoals.storeCredential')}</Button>
      </form>}
    {saved&&<p role="status">{t('sourceGoals.credentialSaved')}</p>}
    {error&&<p role="alert">{t('sourceGoals.errorHint')}</p>}
    <SpaceLink className="underline" to="/sources/goals">{t('sourceGoals.goals')}</SpaceLink>
  </Card>
}
