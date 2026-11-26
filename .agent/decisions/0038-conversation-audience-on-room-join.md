# ADR 0038 — Joining a Room without its history freezes its conversations to their audience

Date: 2026-11-24
Status: accepted (the owner's confirmed design). Phase 1 is implemented: the backend boundary, the invitation choice,
and the audience shown on every conversation. The sidebar and Agent-creation phases of the same request are tracked
in [`.agent/plans/project-room-unification-plan.md`](../plans/project-room-unification-plan.md).

Refines [ADR 0018](0018-room-as-visibility-boundary.md); nothing there is superseded. A Room is still the visibility
boundary, and its roster still answers "who may see". What this decision adds is what an existing conversation means
when that roster grows.

## Context

Project conversations are one Room model. Whether a Room is one person's or several is decided by its human audience,
and the number of Agents in it has nothing to do with that. Before this change, inviting someone into a Room silently
gave them every conversation it had ever held. That was ADR 0018's rule applied to the *current* roster, but nobody
had decided it at the moment of the invitation. A person opening a Room to a colleague should decide whether the
colleague reads what was said before. "Not now" should not mean "never talk together", and it should not mean the
owner can no longer continue their own thread.

## Decision

1. **The invitation carries the choice, off by default.** `share_history` (`room_user_invitations.share_history`,
   `RoomInvitationCreateRequest.share_history`) defaults to `false`. An invitation already pending with another
   choice is replaced, not reused.
2. **Activation is one atomic change.** In the activation transaction, before the member row is inserted, every
   conversation of the Room that is not already frozen is frozen. That covers active, archived and recycle-bin
   conversations, so a restore cannot reopen one. Freezing records a `room_conversation_audiences` marker and one
   `room_conversation_audience_members` row per person in the Room's current audience. That audience is
   `roomAudience`, the read gate's answer, not the roster: a mainline's audience is every Project reader. In the
   same transaction a new conversation (a draft, ADR 0018 decision 5) is opened for the whole new audience. Its id is
   returned to the inviter and invitee as `shared_conversation_id`. A Room with no conversation freezes nothing and
   opens nothing.
3. **A frozen conversation is never widened.** A later invitation that shares history leaves frozen conversations as
   they are. Being recorded for a frozen conversation does not survive leaving the Room or the Project: every read
   ANDs the Room gate and the conversation term (`roomConversationAudienceSql`, `roomSessionReadAccessSql`).
4. **The owner may continue in a frozen conversation.** Messages, Runs, Proposals and Artifacts added afterwards stay
   with its frozen audience. Nothing about a message is per-message; it inherits the conversation's audience.
5. **One predicate, every path.** The conversation term is applied to these paths:
   - conversation list and counts, direct reads, sends and every conversation command addressed by id (404, the same
     answer as a missing conversation);
   - the Project conversation list and the Rooms index counts and last activity;
   - attachments, images, input resources and file snapshots;
   - attention and unread state, Run, Run group, Run stream and work-product reads (`roomRunReadAccessSql`), and Run
     execution admission;
   - Runtime Context delivery and work-context scopes, Skills;
   - Thread References' "who already saw it" (`roomAudience(…, sessionId)`), plugin data audience, and the Agent's
     standing context.
6. **Agent notes follow their conversation.** An agent-scope note records `memory_entries.origin_session_id`. It
   reaches a dispatch only when everyone in the target conversation's audience can read the note's own conversation.
   A note whose conversation was recorded but no longer exists reaches no audience. A note with no recorded
   conversation (earlier notes, revisions) is held to the conservative rule: everyone in the audience must be able
   to read every conversation of its Room that was frozen and created no later than the note. A revision from
   another conversation drops the recorded conversation.
7. **Existing data needs no backfill.** No conversation is frozen before this change, so every existing conversation
   keeps its whole-Room audience, as before. Existing notes have no recorded conversation and fall under §6's
   conservative rule once their Room has a frozen conversation.

## Consequences

- The Room still answers "who may see" for the Room. A conversation additionally names its actual audience
  (`RoomConversation.audience`: `restricted` and `other_member_names`), and the interface shows it on every
  conversation.
- Activation takes the Room lock that conversation creation and sends take (`lockRoomForTurn`, `requireRoom(…, true)`),
  so a conversation or message committed before activation belongs to the earlier audience, and one written after
  sees the new member. A session created by a path that does not take the Room lock and commits after the snapshot
  is left unfrozen. Every current creation path takes it.
- What an Agent's vendor session already holds is not retracted (ADR 0003 §4). A frozen conversation keeps its own
  host threads, and the new conversation starts its own, so nothing is carried across by session reuse.
- Gmail digests and handoff checks still measure the Room's audience. That never narrows, so they over-count and
  refuse more; they do not admit more.

## Non-goals

- Per-message audiences, or narrowing an existing conversation in any other way.
- Re-widening a frozen conversation. Sharing it later would be a new, explicit disclosure, the Thread Reference
  path.
