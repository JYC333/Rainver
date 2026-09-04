import { type VariantProps, cva } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer',
  {
    variants: {
      variant: {
        default:     'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:   'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline:     'border border-border bg-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground',
        ghost:       'bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent',
        destructive: 'bg-destructive/15 text-destructive border border-destructive/25 hover:bg-destructive/25',
        success:     'bg-success/15 text-success border border-success/25 hover:bg-success/25',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm:      'h-7 px-2.5 text-xs',
        lg:      'h-11 px-6',
        icon:    'h-9 w-9',
        // The AI Elements message toolbar sizes its actions smaller than a
        // standalone icon button.
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp: React.ElementType = asChild ? Slot : 'button'
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
