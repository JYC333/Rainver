import { useEffect, useRef, useState } from 'react'
import { useConversationOverlay } from './useConversationOverlay'
import type { ReactNode } from 'react'
import { ArrowLeft, Menu, MessageSquarePlus } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../../components/ui/dialog'
import { ConversationStatusIndicator } from '../ConversationUnreadDot'
import { useAppTranslation } from '../../../i18n'
import type { RoomConversation } from '../../../types/api'

/** Navigation only: the transcript stays mounted across drawer/viewport changes. */
export function MobileConversationNavigation({ title, room, audience, conversations, selected, unread, onSelect, onNew, back, children, onCarry, carryLabel }: {
  title: string; room: string; audience: string; conversations: RoomConversation[]; selected: string | null
  unread: ReadonlySet<string>; onSelect: (id: string) => void; onNew: () => void
  back: ReactNode; children?: ReactNode; onCarry?: () => void; carryLabel?: string
}) {
  const { t } = useAppTranslation()
  const { open, close, show } = useConversationOverlay('conversationDrawer')
  const setOpen = (value: boolean) => { if (value) show(); else close() }
  useEffect(() => {
    if (!open) return
    const media = matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (media.matches) close() }
    closeOnDesktop()
    media.addEventListener('change', closeOnDesktop)
    return () => media.removeEventListener('change', closeOnDesktop)
  }, [open])
  const [query, setQuery] = useState('')
  const drawerRef = useRef<HTMLDivElement>(null)
  return <header className="flex shrink-0 items-center gap-1 border-b border-border bg-card p-2 lg:hidden" data-mobile-conversation-header>
    {back}
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-semibold">{title}</p>
      <p className="truncate text-xs text-muted-foreground">{room} · {audience}</p>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="ghost" className="min-h-11 min-w-11" aria-label={t('collab_ui.mobile.conversations')}><Menu className="size-5" /></Button></DialogTrigger>
      <DialogContent ref={drawerRef} className="mobile-conversation-drawer translate-x-0 translate-y-0 flex min-h-0 flex-col gap-3" aria-describedby="mobile-room-audience"
        onOpenAutoFocus={event => { event.preventDefault(); drawerRef.current?.focus({ preventScroll: true }) }}>
        <DialogTitle className="pr-6">{room}</DialogTitle>
        <DialogDescription id="mobile-room-audience">{audience}</DialogDescription>
        <Input aria-label={t('collab_ui.mobile.search')} placeholder={t('collab_ui.mobile.search')} value={query} onChange={event => setQuery(event.target.value)} />
        <Button size="sm" onClick={() => { close(selected ? onNew : undefined) }}>{t('collab_ui.room.new_conversation')}</Button>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-y-contain" aria-label={t('collab_ui.mobile.conversations')}>
          {conversations.filter(item => (item.title ?? t('collab_ui.room.untitled')).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <Button key={item.id} variant={item.id === selected ? 'secondary' : 'ghost'} className="w-full justify-start" aria-current={item.id === selected ? 'page' : undefined} onClick={() => { close(item.id !== selected ? () => onSelect(item.id) : undefined) }}>
            <span className="min-w-0 flex-1 truncate text-left">{item.title || t('collab_ui.room.untitled')}</span>
            <ConversationStatusIndicator running={item.is_running} unread={unread.has(item.id)} />
          </Button>)}
        </nav>
        {onCarry && <Button size="sm" variant="ghost" className="min-h-11 justify-start" onClick={() => close(onCarry)}><MessageSquarePlus className="size-4" />{carryLabel}</Button>}
        {children && <div className="max-h-[30dvh] shrink-0 overflow-y-auto border-t border-border pt-2">{children}</div>}
      </DialogContent>
    </Dialog>
  </header>
}

export function MobileConversationBack({ onClick, label }: { onClick: () => void; label: string }) {
  return <Button size="sm" variant="ghost" className="min-h-11 min-w-11" onClick={onClick} aria-label={label}><ArrowLeft className="size-5" /></Button>
}
