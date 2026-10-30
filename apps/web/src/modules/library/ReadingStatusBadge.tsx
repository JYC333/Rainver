import type {ReadingItem} from '@rainver/protocol'
import {Badge} from '../../components/ui/badge'
import {useAppTranslation} from '../../i18n'

/** One status slot shared by main Reading and Following; no extra card badge. */
export function ReadingStatusBadge({item,topic}:{item:ReadingItem;topic?:string}){
 const {t}=useAppTranslation()
 const justCollected=item.read_status==='unread'&&!item.topic_change&&item.topics.some(link=>(!topic||link.goal_id===topic)&&link.new_in_latest_collection===true)
 const read=item.read_status==='read'||item.read_status==='discussed'
 return <Badge variant={justCollected?'default':read?'success':'muted'}
  title={justCollected?t('topics.newlyCollectedHint'):undefined}
  aria-label={justCollected?`${t('reading.status_unread')} · ${t('topics.newlyCollected')}`:undefined}>
  {t(justCollected?'topics.newlyCollected':`reading.status_${item.read_status}`)}
 </Badge>
}
