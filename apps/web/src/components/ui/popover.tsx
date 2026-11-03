import * as PopoverPrimitive from '@radix-ui/react-popover'
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger

export const PopoverContent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(function PopoverContent({ className, sideOffset = 6, collisionPadding = 12, ...props }, ref) {
  return <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding}
      className={cn('z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-border bg-card p-3 text-sm text-foreground shadow-md outline-none', className)} {...props}/>
  </PopoverPrimitive.Portal>
})
