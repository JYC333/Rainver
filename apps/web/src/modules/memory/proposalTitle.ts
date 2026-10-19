import type { ProposalTitleParts } from '@rainver/protocol'
import i18n from '../../i18n'

/**
 * The title a person reads. A proposal that records its title facts is worded
 * in the UI language; any other proposal shows its stored title.
 */
export function proposalTitle(storedTitle: string, parts: ProposalTitleParts | null | undefined): string {
  if (!parts) return storedTitle
  const type = i18n.t(`workspace_ui.proposal_title.scope.${parts.target_scope_type}`, { defaultValue: parts.target_scope_type })
  return i18n.t('workspace_ui.proposal_title.asset_version_promote', {
    asset: parts.asset_key,
    version: parts.version,
    scope: parts.target_scope_id ? i18n.t('workspace_ui.proposal_title.scope_with_id', { type, id: parts.target_scope_id }) : type,
  })
}
