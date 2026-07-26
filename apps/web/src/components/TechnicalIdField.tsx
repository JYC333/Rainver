import { Input } from './ui/input'
import { Label } from './ui/label'

/**
 * Explicit developer/audit-only identifier input. Product forms must use named
 * selectors instead; the UUID semantic guard permits raw identifiers only
 * through this technical-details affordance.
 */
export function TechnicalIdField({
  label,
  value,
  onChange,
  placeholder = 'Paste an internal identifier',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return <details className="rounded-md border border-border bg-muted/20 p-2">
    <summary className="cursor-pointer text-xs text-muted-foreground">Technical identifier</summary>
    <div className="mt-2 space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input className="font-mono text-xs" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    </div>
  </details>
}
