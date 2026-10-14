import { useEffect, useState } from 'react'
import { Loader2, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi } from '../../api/client'
import type {
  SpaceAssistantSettingsOut,
  SpaceAssistantSettingsUpdate,
  AssistantResponseStyle,
  AssistantVerbosity,
  AssistantProposalStyle,
} from '../../types/api'
import { Card, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/select'
import { errMsg } from '../../lib/utils'

/**
 * Minimal Assistant preferences panel. These are SOFT defaults only — they shape
 * default UI/context behavior. The core system prompt, hard safety policy, and the
 * shell/file/workspace/credential permissions are NOT editable here by design.
 */

const RESPONSE_STYLES: { value: AssistantResponseStyle; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'direct', label: 'Direct' },
  { value: 'formal', label: 'Formal' },
]
const VERBOSITY: { value: AssistantVerbosity; label: string }[] = [
  { value: 'concise', label: 'Concise' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' },
]
const PROPOSAL_STYLES: { value: AssistantProposalStyle; label: string }[] = [
  { value: 'proactive', label: 'More proactive' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'conservative', label: 'Conservative' },
]
const CONTEXT_TOGGLES: { key: string; label: string }[] = [
  { key: 'memory', label: 'Memory' },
  { key: 'wiki', label: 'Wiki' },
  { key: 'sources', label: 'Sources' },
  { key: 'recent_activities', label: 'Recent activities' },
  { key: 'current_project', label: 'Current project' },
]

export default function AssistantSettingsPanel() {
  const [settings, setSettings] = useState<SpaceAssistantSettingsOut | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    agentsApi.getAssistantSettings()
      .then(setSettings)
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [])

  function patch(update: SpaceAssistantSettingsUpdate) {
    setSettings(prev => (prev ? { ...prev, ...update } as SpaceAssistantSettingsOut : prev))
  }

  function toggleContext(key: string, value: boolean) {
    setSettings(prev => prev
      ? { ...prev, default_context_toggles_json: { ...prev.default_context_toggles_json, [key]: value } }
      : prev)
  }

  async function save() {
    if (!settings) return
    setSaving(true)
    try {
      const updated = await agentsApi.updateAssistantSettings({
        response_style: settings.response_style,
        verbosity: settings.verbosity,
        proposal_style: settings.proposal_style,
        default_context_toggles_json: settings.default_context_toggles_json,
      })
      setSettings(updated)
      toast.success('Assistant preferences saved')
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <Card><div className="flex items-center gap-2 text-muted-foreground p-2"><Loader2 className="size-4 animate-spin" /> Loading assistant settings…</div></Card>
  }
  if (!settings) return null

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="size-4" />
        <CardTitle>Assistant preferences</CardTitle>
      </div>
      <p className="text-xs text-muted-foreground">
        Preferences shape default behavior only. The assistant's core prompt and safety
        policy are system-managed and cannot be edited here.
      </p>
      {!settings.can_configure && (
        <p className="text-xs text-muted-foreground" role="note">
          {settings.scope === 'project'
            ? "Only this Project's owner can change its Assistant's preferences."
            : "Only the person who created this Space can change its Assistant's preferences."}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Response style</span>
          <Select size="sm" options={RESPONSE_STYLES} value={settings.response_style ?? 'neutral'}
            onChange={v => patch({ response_style: v as AssistantResponseStyle })} />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Verbosity</span>
          <Select size="sm" options={VERBOSITY} value={settings.verbosity ?? 'balanced'}
            onChange={v => patch({ verbosity: v as AssistantVerbosity })} />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Proposal behavior</span>
          <Select size="sm" options={PROPOSAL_STYLES} value={settings.proposal_style ?? 'balanced'}
            onChange={v => patch({ proposal_style: v as AssistantProposalStyle })} />
        </label>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">Default context</span>
        <div className="flex flex-wrap gap-3">
          {CONTEXT_TOGGLES.map(t => (
            <label key={t.key} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={!!settings.default_context_toggles_json?.[t.key]}
                onChange={e => toggleContext(t.key, e.target.checked)}
              />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="pt-2 border-t border-border">
        <Button size="sm" onClick={save} disabled={saving || !settings.can_configure}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : 'Save preferences'}
        </Button>
      </div>
    </Card>
  )
}
