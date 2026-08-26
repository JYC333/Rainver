import type {
  KnowledgeContentFormat,
  KnowledgeItemKind,
  KnowledgeItemStatus,
  KnowledgeRelationStatus,
  KnowledgeLinkType,
  KnowledgeVisibility,
} from '../../types/api'

export const KNOWLEDGE_ITEM_KINDS: KnowledgeItemKind[] = [
  'concept',
  'lesson',
  'procedure',
  'decision',
  'question',
  'answer',
  'summary',
]

export const KNOWLEDGE_STATUSES: KnowledgeItemStatus[] = ['draft', 'active', 'superseded', 'archived']
export const KNOWLEDGE_VISIBILITIES: KnowledgeVisibility[] = ['private', 'space_shared', 'selected_users']
export const KNOWLEDGE_FORMATS: KnowledgeContentFormat[] = ['markdown', 'plain']

export const KNOWLEDGE_LINK_TYPES: KnowledgeLinkType[] = [
  'related_to',
  'explains',
  'depends_on',
  'prerequisite_of',
  'part_of',
  'example_of',
  'applies_to',
  'supports',
  'contradicts',
  'derived_from',
  'summarizes',
  'updates',
]

export const KNOWLEDGE_RELATION_STATUSES: Extract<KnowledgeRelationStatus, 'candidate' | 'active'>[] = ['candidate', 'active']

export function fmt(dt: string | null | undefined): string {
  return dt ? new Date(dt).toLocaleString() : '-'
}

export function parseTags(value: string): string[] {
  return value.split(',').map(t => t.trim()).filter(Boolean)
}

export function parseOptionalConfidence(value: string): number | null {
  if (!value.trim()) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}

export function validateConfidence(value: number | null): boolean {
  return !Number.isNaN(value) && (value === null || (value >= 0 && value <= 1))
}

// ── Knowledge section navigation ───────────────────────────────────────────
/**
 * Sub-areas of the first-level Knowledge module. `home` is the optional overview
 * hub; the other four are the working sections. `/knowledge` opens the last-used
 * *section* (never `home`, which stays an intentional destination) and defaults
 * to `notes` on a fresh client. See KnowledgeModule / KnowledgeSectionHeader.
 */
/**
 * `domains` (focus areas) is a section but deliberately not a workspace section:
 * it is parked under Knowledge until the app has a home for life-area groupings,
 * so `/knowledge` should not reopen it as a last-used destination.
 */
export type KnowledgeSection = 'home' | 'notes' | 'wiki' | 'sources' | 'cards' | 'domains'

/** Sections eligible to be remembered as the `/knowledge` redirect target. */
export const KNOWLEDGE_WORKSPACE_SECTIONS: Exclude<KnowledgeSection, 'home'>[] = [
  'notes',
  'wiki',
  'sources',
  'cards',
]

export const DEFAULT_KNOWLEDGE_SECTION: KnowledgeSection = 'notes'

const LAST_SECTION_KEY = 'rainver:knowledge-section'

function isWorkingSection(value: string): value is Exclude<KnowledgeSection, 'home'> {
  return (KNOWLEDGE_WORKSPACE_SECTIONS as string[]).includes(value)
}

/** The section `/knowledge` should redirect to: last-used workspace, else Notes. */
export function readLastKnowledgeSection(): Exclude<KnowledgeSection, 'home'> {
  try {
    const v = localStorage.getItem(LAST_SECTION_KEY)
    if (v && isWorkingSection(v)) return v
  } catch {
    /* ignore */
  }
  return DEFAULT_KNOWLEDGE_SECTION as Exclude<KnowledgeSection, 'home'>
}

/**
 * Remember the active section so `/knowledge` reopens it next time. `home` is
 * intentionally not persisted — the overview must never become the default landing.
 */
export function rememberKnowledgeSection(section: KnowledgeSection): void {
  if (!isWorkingSection(section)) return
  try {
    localStorage.setItem(LAST_SECTION_KEY, section)
  } catch {
    /* ignore */
  }
}
