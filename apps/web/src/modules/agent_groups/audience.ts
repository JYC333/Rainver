/**
 * What to call a Room: the people in it.
 *
 * A Room's title is a label somebody typed; its roster is the thing that makes
 * it a separate group at all, and it is the only fact a reader needs in order
 * to know why a section or a header exists
 * ([ADR 0018](../../../../.agent/decisions/0018-room-as-visibility-boundary.md)
 * decision 2). One definition, used by the Project's conversation list and by
 * the Room page's conversation header, so the two cannot describe the same
 * Room differently.
 *
 * The viewer is always excluded: "with you, Alice and Bob" is noise on a label
 * the viewer is reading.
 */
export function audienceLabel(
  input: { otherMemberNames: string[]; agentCount: number },
  t?: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (t) {
    const names = input.otherMemberNames
    const joined = names.length <= 2
      ? names.join(t('collab_ui.audience.and'))
      : `${names.slice(0, -1).join(t('collab_ui.audience.comma'))}${t('collab_ui.audience.and')}${names[names.length - 1]}`
    const localized = names.length === 0 ? t('collab_ui.audience.just_you') : t('collab_ui.audience.with', { names: joined })
    return input.agentCount === 0 ? localized : `${localized} · ${t('collab_ui.audience.agents', { count: input.agentCount })}`
  }
  const people = input.otherMemberNames.length === 0
    ? 'Just you'
    : `With ${formatNames(input.otherMemberNames)}`
  // A Room nobody has spoken in has no manager Agent yet — provisioning waits
  // for the first message (ADR 0018 decision 4) — and "· 0 agents" would
  // announce an implementation detail on exactly the Room a person just made.
  if (input.agentCount === 0) return people
  return `${people} · ${input.agentCount === 1 ? '1 agent' : `${input.agentCount} agents`}`
}

/**
 * Who can see a Room, as the Rooms index and the Room header say it: the
 * mainline is the whole Project; a limited Room is named by its audience.
 */
export function roomVisibilityLabel(
  input: { isMainline: boolean; otherMemberNames: string[] },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (input.isMainline) return t('collab_ui.audience.everyone')
  return audienceLabel({ otherMemberNames: input.otherMemberNames, agentCount: 0 }, t)
}

/**
 * Who actually reads one conversation. Usually its Room's audience; a
 * conversation frozen when someone joined without its history
 * ([ADR 0038](../../../../.agent/decisions/0038-conversation-audience-on-room-join.md))
 * names its own, narrower audience and says why.
 */
export function conversationAudienceLabel(
  input: {
    isMainline: boolean
    roomOtherMemberNames: string[]
    audience?: { restricted: boolean; other_member_names: string[] } | null
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (input.audience?.restricted) {
    return `${audienceLabel({ otherMemberNames: input.audience.other_member_names, agentCount: 0 }, t)} · ${t('collab_ui.audience.earlier_members')}`
  }
  if (input.isMainline) return t('collab_ui.audience.everyone')
  return audienceLabel({ otherMemberNames: input.audience?.other_member_names ?? input.roomOtherMemberNames, agentCount: 0 }, t)
}

/** "2 people · 1 agent", pluralized per locale. */
export function rosterCountsLabel(
  input: { people: number; agents: number },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return `${t('collab_ui.rooms.people', { count: input.people })} · ${t('collab_ui.rooms.agents', { count: input.agents })}`
}

// Not `Intl.ListFormat`: the web target's lib is ES2020, and raising it for
// one call site is a compiler-wide change out of proportion to a join.
function formatNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * How a person is named anywhere the roster, a dialog or a reference shows
 * one: display name, then email, then the id — the same fallback in the same
 * order, so the same person is never called two things on one screen.
 */
export function personLabel(person: { display_name?: string | null; email?: string | null; user_id: string }): string {
  return person.display_name || person.email || person.user_id
}
