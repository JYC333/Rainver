import { type VariantProps, cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default:     'bg-primary/15 text-accent-foreground',
        secondary:   'bg-secondary text-secondary-foreground',
        success:     'bg-success/15 text-success',
        warning:     'bg-warning/15 text-warning',
        destructive: 'bg-destructive/15 text-destructive',
        muted:       'bg-muted text-muted-foreground',
        outline:     'border border-border text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  active:     'success',
  accepted:   'success',
  completed:  'success',
  succeeded:  'success',
  healthy:    'success',
  pass:       'success',
  pending:    'warning',
  queued:     'muted',
  running:    'warning',
  attention:  'warning',
  rejected:   'destructive',
  failed:     'destructive',
  failing:    'destructive',
  fail:       'destructive',
  no_data:    'muted',
  observed:   'muted',
  cancelled:  'muted',
  degraded:   'warning',
  waiting_for_review: 'warning',
  waiting_for_dependency: 'warning',
  archived:   'muted',
  superseded: 'muted',
  inactive:   'muted',
  paused:     'muted',
  disabled:   'destructive',
}

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'muted'} className={className}>
      {label ?? status}
    </Badge>
  )
}
