import { SlidersHorizontal, Zap } from 'lucide-react'
import type { RuntimeSessionConfigOption, RuntimeSessionConfigSelection } from '../../types/api'
import { Select } from '../../components/ui/select'
import { cn } from '../../lib/utils'

export type SessionConfigSelection = RuntimeSessionConfigSelection

export function ConversationSessionConfig({
  options,
  value,
  onChange,
  disabled,
}: {
  options: RuntimeSessionConfigOption[]
  value: SessionConfigSelection[]
  onChange: (value: SessionConfigSelection[]) => void
  disabled?: boolean
}) {
  const ordered = configurableOptions(options)
    .sort((left, right) => categoryOrder(left.category) - categoryOrder(right.category))
  const setValue = (option: RuntimeSessionConfigOption, next: string | boolean) => {
    onChange([
      ...value.filter(selection => selection.id !== option.id),
      { id: option.id, type: option.type, value: next, category: option.category },
    ])
  }
  return ordered.map(option => {
    const selected = value.find(selection => selection.id === option.id)?.value ?? option.current_value
    if (option.type === 'boolean') {
      const active = typeof selected === 'boolean' ? selected : option.current_value
      const Icon = option.category === 'model_config' ? Zap : SlidersHorizontal
      return (
        <button
          key={option.id}
          type="button"
          role="switch"
          aria-checked={active}
          aria-label={option.name}
          title={option.description ?? option.name}
          disabled={disabled}
          onClick={() => setValue(option, !active)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-50',
            active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" /> {option.name}
        </button>
      )
    }
    return (
      <Select
        key={option.id}
        size="sm"
        dropUp
        disabled={disabled}
        ariaLabel={option.name}
        className="max-w-48"
        value={typeof selected === 'string' ? selected : option.current_value}
        onChange={next => setValue(option, next)}
        options={option.options.map(choice => ({
          value: choice.value,
          label: `${choice.group ? `${choice.group} · ` : ''}${choice.name ?? choice.value}`,
        }))}
      />
    )
  })
}

export function defaultSessionConfig(options: RuntimeSessionConfigOption[]): SessionConfigSelection[] {
  return configurableOptions(options).map(option => ({
    id: option.id,
    type: option.type,
    value: option.current_value,
    category: option.category,
  }))
}

export function mergeSessionConfig(
  options: RuntimeSessionConfigOption[],
  persisted: SessionConfigSelection[],
): SessionConfigSelection[] {
  return defaultSessionConfig(options).map(fallback => {
    const option = options.find(candidate => candidate.id === fallback.id)!
    const saved = persisted.find(candidate => candidate.id === fallback.id
      && candidate.type === fallback.type && candidate.category === fallback.category)
    if (!saved) return fallback
    if (option.type === 'boolean') return typeof saved.value === 'boolean' ? saved : fallback
    return typeof saved.value === 'string' && option.options.some(choice => choice.value === saved.value)
      ? saved : fallback
  })
}

function configurableOptions(options: RuntimeSessionConfigOption[]): RuntimeSessionConfigOption[] {
  return options.filter(option => option.type === 'boolean'
    || option.options.some(choice => choice.value === option.current_value))
}

function categoryOrder(category: string | null): number {
  return category === 'model' ? 0
    : category === 'mode' ? 1
      : category === 'thought_level' ? 2
        : category === 'model_config' ? 3 : 4
}
