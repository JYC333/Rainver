import type { ReaderAppearance } from '@rainver/protocol'
import { Button } from '../ui/button'
import { useAppTranslation } from '../../i18n'
import { cn } from '../../lib/utils'

const SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26] as const

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <fieldset className="space-y-1.5">
    <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
    <div className="flex flex-wrap gap-1">
      {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value}
        className={cn('min-h-9 rounded-md border px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          value === option.value ? 'border-primary bg-primary/12 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}
        onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  </fieldset>
}

/** Font size, line spacing, width, typeface and page colour of the Reader; saved in the person's own settings. */
export function ReaderAppearancePanel({ appearance, onChange, onReset }: { appearance: ReaderAppearance; onChange: (patch: Partial<ReaderAppearance>) => void; onReset: () => void }) {
  const { t } = useAppTranslation()
  const sizeIndex = appearance.font_size == null ? -1 : SIZES.indexOf(appearance.font_size as typeof SIZES[number])
  const step = (delta: number) => {
    const from = sizeIndex >= 0 ? sizeIndex : SIZES.indexOf(18)
    onChange({ font_size: SIZES[Math.max(0, Math.min(SIZES.length - 1, from + delta))] })
  }
  return <div className="w-full space-y-4 p-1">
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">{t('reading.appearanceSize')}</legend>
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" aria-label={t('reading.appearanceSmaller')} disabled={sizeIndex === 0} onClick={() => step(-1)}><span className="text-xs">A</span></Button>
        <span className="min-w-16 text-center text-sm tabular-nums" aria-live="polite">{appearance.font_size ? `${appearance.font_size}px` : t('reading.appearanceAuto')}</span>
        <Button size="icon" variant="outline" aria-label={t('reading.appearanceLarger')} disabled={sizeIndex === SIZES.length - 1} onClick={() => step(1)}><span className="text-lg">A</span></Button>
      </div>
    </fieldset>
    <Choice label={t('reading.appearanceLineHeight')} value={appearance.line_height} onChange={line_height => onChange({ line_height })}
      options={(['compact', 'normal', 'relaxed'] as const).map(value => ({ value, label: t(`reading.lineHeight_${value}`) }))} />
    <Choice label={t('reading.appearanceWidth')} value={appearance.width} onChange={width => onChange({ width })}
      options={(['narrow', 'medium', 'wide'] as const).map(value => ({ value, label: t(`reading.width_${value}`) }))} />
    <Choice label={t('reading.appearanceFont')} value={appearance.font} onChange={font => onChange({ font })}
      options={(['sans', 'serif'] as const).map(value => ({ value, label: t(`reading.font_${value}`) }))} />
    <Choice label={t('reading.appearanceTheme')} value={appearance.theme} onChange={theme => onChange({ theme })}
      options={(['app', 'light', 'sepia', 'dark'] as const).map(value => ({ value, label: t(`reading.theme_${value}`) }))} />
    <Button size="sm" variant="ghost" onClick={onReset}>{t('reading.appearanceReset')}</Button>
  </div>
}
