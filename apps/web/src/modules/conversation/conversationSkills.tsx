import { useEffect, useState } from 'react'
import type { ConversationInputPart, ConversationInputSkillPart } from '@rainver/protocol'
import { capabilitiesFrameworkApi } from '../../api/client'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { ConversationLink, useConversationScope } from './ConversationScope'

export function skillReferenceText(skill: ConversationInputSkillPart): string {
  return `/${skill.display_name}`
}

export interface SkillReferenceRange { from: number; to: number; skill: ConversationInputSkillPart }

/** Complete visible references, in text order; the typed input part still owns package identity. */
export function skillReferenceRanges(text: string, skills: ConversationInputSkillPart[]): SkillReferenceRange[] {
  const ranges: SkillReferenceRange[] = []
  for (const skill of skills) {
    const reference = skillReferenceText(skill)
    let at = text.indexOf(reference)
    while (at >= 0) {
      const before = text[at - 1]
      const after = text[at + reference.length]
      if ((!before || /\s/u.test(before)) && (!after || !/[\p{L}\p{N}_-]/u.test(after))) ranges.push({ from: at, to: at + reference.length, skill })
      at = text.indexOf(reference, at + reference.length)
    }
  }
  return ranges.sort((a, b) => a.from - b.from)
}

export function hasSkillReference(text: string, skill: ConversationInputSkillPart): boolean {
  return skillReferenceRanges(text, [skill]).length > 0
}

/**
 * Skills the next turn may select. A Room passes its addressed Agents: the
 * server offers only Skills enabled for every one of them (none addressed
 * means the manager), matching what sending admits.
 */
export function useAvailableSkills({ sessionId, projectId, agentId, recipientAgentIds, enabled }: {
  sessionId?: string | null; projectId?: string | null; agentId?: string | null; recipientAgentIds?: readonly string[]; enabled: boolean
}) {
  const scope = useConversationScope()
  const [skills, setSkills] = useState<ConversationInputSkillPart[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // True once the current catalog has answered, so an empty menu is known to be empty.
  const [loaded, setLoaded] = useState(false)
  const recipients = recipientAgentIds?.length ? [...new Set(recipientAgentIds)].sort().join(',') : ''
  useEffect(() => {
    setSkills([]); setError(''); setLoaded(false)
    if (!enabled) { setLoading(false); return }
    let active = true
    setLoading(true)
    capabilitiesFrameworkApi.availableSkills({
      session_id: sessionId, project_id: projectId, agent_id: agentId,
      ...(recipients ? { recipient_agent_ids: recipients.split(',') } : {}),
    }, scope)
      .then(items => { if (active && !scope.signal?.aborted) { setSkills(items); setLoaded(true) } })
      .catch(error => { if (active && !scope.signal?.aborted) setError(errMsg(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [enabled, sessionId, projectId, agentId, recipients, scope])
  return { skills, error, loading, loaded }
}

/** Empty `/` and `@` Skill menus explain why a newly imported Skill is missing and link to the library. */
export function SkillMenuEmptyHint() {
  const { t } = useAppTranslation()
  return <>{t('skill_packages.empty')}{' '}
    <ConversationLink className="text-primary underline" to="/skills" onMouseDown={event => event.preventDefault()}>{t('skill_packages.open_library')}</ConversationLink></>
}

export function SelectedSkillChips({ parts }: { parts: ConversationInputPart[] }) {
  const { t } = useAppTranslation()
  const skills = parts.filter(part => part.kind === 'skill')
  if (!skills.length) return null
  return <div className="flex flex-wrap gap-1.5 px-3 py-2" aria-label={t('skill_packages.selected')}>
    {skills.map(skill => <span key={skill.skill_package_id} className="inline-flex max-w-full items-center gap-1 rounded border border-primary/30 bg-primary/5 px-2 py-1 text-xs" title={skill.package_hash}>
      <span className="truncate">/{skill.display_name}</span>
    </span>)}
  </div>
}
