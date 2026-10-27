import { forwardRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { type ButtonProps, Button } from './button'
import { useAppTranslation } from '../../i18n'

export const Dialog        = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose   = DialogPrimitive.Close

const DialogOverlay = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-black/60',
        'data-[state=open]:animate-in   data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0    data-[state=closed]:fade-out-0',
        className
      )}
      {...props}
    />
  )
})

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showClose?: boolean
}

export const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, showClose = true, ...props }, ref) {
  const { t } = useAppTranslation()
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-lg rounded-lg bg-card p-6 shadow-xl',
          'data-[state=open]:animate-in   data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0    data-[state=closed]:fade-out-0',
          'data-[state=open]:zoom-in-95   data-[state=closed]:zoom-out-95',
          'data-[state=open]:slide-in-from-left-1/2  data-[state=open]:slide-in-from-top-[48%]',
          'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
          className
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-ring">
            <X className="size-4" />
            <span className="sr-only">{t('core_ui.dialog.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-5', className)} {...props} />
}

export const DialogTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold text-foreground leading-tight', className)}
      {...props}
    />
  )
})

export const DialogDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('mt-1.5 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
})

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex justify-end gap-2 mt-6 pt-4 border-t border-border', className)}
      {...props}
    />
  )
}

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  onConfirm: () => void
  confirmLabel?: string
  cancelLabel?: string
  variant?: ButtonProps['variant']
  restoreAvailable?: boolean
  restoreChecked?: boolean
  onRestoreChange?: (checked: boolean) => void
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel,
  cancelLabel,
  variant = 'destructive',
  restoreAvailable = false,
  restoreChecked = false,
  onRestoreChange,
}: ConfirmDialogProps) {
  const { t } = useAppTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="max-w-sm">
        <DialogHeader className="mb-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {restoreAvailable && (
          <label className="mb-4 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={restoreChecked} onChange={event => onRestoreChange?.(event.target.checked)} />
            <span><span className="font-medium">{t('core_ui.dialog.restore_title')}</span><span className="block text-xs text-muted-foreground">{t('core_ui.dialog.restore_description')}</span></span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{cancelLabel ?? t('core_ui.dialog.cancel')}</Button>
          <Button
            variant={variant}
            onClick={() => { onConfirm(); onOpenChange(false) }}
          >
            {confirmLabel ?? t('core_ui.dialog.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
