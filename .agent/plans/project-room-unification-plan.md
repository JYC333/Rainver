# Project Room unification: phases

A working plan, not authority (CLAUDE.md "Repo Rules"). The owner's request on 2026-11-24 has three parts; this file
records how they were staged and what remains. Current behavior lives in the module guides and ADR 0038.

## 1. One Room model, conversation audience (Phase 1: implemented)

- Implemented: a Room is single- or multi-person by its human audience, and its Agent count is independent of that.
  An invitation chooses `share_history`, off by default. Activation atomically freezes the existing conversations and
  opens a shared conversation. One audience predicate gates every conversation-scoped path, and Agent notes record
  their conversation. See [ADR 0038](../decisions/0038-conversation-audience-on-room-join.md) and `modules/rooms.md`,
  "Conversation audience". Tests: `server/test/roomConversationAudienceDb.test.ts`.

## 2. Right sidebar (Phase 2: implemented)

- One toggle entry. Two fixed tabs, Conversations and Rooms; the Conversations tab defaults to the current Room.
- Long lists scroll and can be searched. Switching Rooms restores the last conversation the viewer can see in the
  chosen Room. "New" stays in the current Room.
- The actual conversation audience is always visible. Per-Agent models and participation reuse Conversation Settings.

## 3. Agent creation and plugin Agents (Phase 3: implemented)

- One user-initiated "New Agent" flow: start blank or from an official Role, with the Project prefilled.
- Plugins contribute stable official Roles, loaded by the core. PHD Application contributes exactly one user-facing
  Agent.
- The plugin page sets up once: choose a Room, and reuse an authorized Agent where one exists. A successful setup may
  open the sidebar with that Room preselected. There is no separate chat button, and no Room is created
  automatically.
- Execution requires the current Project to be bound, the plugin enabled and the Room authorized. One Agent may serve
  several compliant Projects with isolated data, sessions and memory. A personal Agent works outside Projects and
  joins a Project explicitly.
- Project preferences reuse the Project memory approval. Out of scope: per-Project×Agent configuration, sub-agents,
  and custom Role publication.

## Remaining

- The Room presets in `rooms/presets.ts` are still separate hard-coded factories in the Room's Add Agent dialog. They
  were not turned into Roles in this change.
