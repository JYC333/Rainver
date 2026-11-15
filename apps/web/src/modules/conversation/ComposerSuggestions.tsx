import type { ReactNode, RefObject } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover'

/** Keep autocomplete outside transcript/composer clipping without taking editor focus. */
export function ComposerSuggestions({ anchorRef, onDismiss, children }: {
  anchorRef: RefObject<HTMLElement | null>
  onDismiss: () => void
  children: ReactNode
}) {
  const dialog = anchorRef.current?.closest<HTMLElement>('[role="dialog"]') ?? undefined
  return <Popover open onOpenChange={open => { if (!open) onDismiss() }}>
    <PopoverAnchor virtualRef={anchorRef} />
    <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={8}
      container={dialog} collisionBoundary={dialog}
      className="z-[1000] flex w-80 flex-col overflow-hidden p-0"
      onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => {
        if (anchorRef.current?.contains(event.target as Node)) event.preventDefault()
      }}
      onEscapeKeyDown={event => { event.preventDefault(); onDismiss() }}>
      {children}
    </PopoverContent>
  </Popover>
}
