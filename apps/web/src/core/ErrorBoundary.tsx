import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useAppTranslation } from '../i18n'

interface Props   { children: ReactNode }
interface State   { error: Error | null }

/**
 * The fallback panel. A function component, so its wording follows a
 * language change while the panel is on screen.
 */
function ErrorPanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useAppTranslation()
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-center">
      <p className="text-sm font-medium text-destructive mb-1">{t('core_ui.error_boundary.title')}</p>
      <p className="text-xs text-muted-foreground font-mono mb-4">{error.message}</p>
      <button
        className="text-xs text-muted-foreground hover:text-foreground underline"
        onClick={onRetry}
      >
        {t('core_ui.error_boundary.retry')}
      </button>
    </div>
  )
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) return <ErrorPanel error={this.state.error} onRetry={() => this.setState({ error: null })} />
    return this.props.children
  }
}
