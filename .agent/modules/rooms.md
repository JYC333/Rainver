# Module: Rooms

## Status
**IMPLEMENTED** — schema, service, and API routes live in `server/src/modules/rooms/`.

## Purpose
A Room is a persistent, project-bound, multi-party collaboration container: a
human and agent roster plus multiple durable conversations. It is the
frontend-facing surface for dispatching work to agents from inside a
conversation. `/projects/:projectId/rooms` is the primary in-Project workspace;
`/rooms` is the cross-Project index. Together they replace the old Project
Chat surface and the hardcoded default-Assistant chat entry — neither exists
anymore.

A Room does not create a new orchestration mechanism. Every message opens one
`agent_run_group` as one collaboration task (see `modules/agents.md` and
`architecture/EXECUTION_MODEL.md`); `agent_run_groups` keeps its "one
collaboration task" semantics unchanged. `/agent-groups` remains the backend
task/audit authority, not a second conversation UI.

## Owns
- `rooms`, `room_user_members`, `room_agent_members` schema (`server/src/db/schema/rooms.ts`)
- `RoomService` — room/conversation creation, membership, message dispatch (`server/src/modules/rooms/service.ts`)
- Room API routes under `/api/v1/rooms/*`
- Shared Room UI (`apps/web/src/modules/agent_groups/AgentGroupsPage.tsx`) at
  `/rooms` for the cross-Project index and `/projects/:projectId/rooms` inside
  the persistent Project Shell

## Key Model

```
Room:
  id, space_id, project_id, project_folder_id (optional)
  created_by_user_id, title, status (active|archived)

RoomUserMember:
  id, space_id, room_id, user_id, role (owner|member), status (active|removed)

RoomAgentMember:
  id, space_id, room_id, agent_id, role (manager|member), status (active|removed)
  # exactly one active manager per Room (partial unique index)

sessions (Room-backed conversation):
  room_id, project_id set; user_id, agent_id NULL
  # ck_sessions_conversation_owner enforces this split against the
  # user-owned chat-session shape on the same table

messages (Room conversation message):
  sender_agent_id — set when the sender is an agent, alongside the existing
  user_id for a human sender
```

A Room requires Project writer authority to create, and every human roster
member must already have Project read access. All later Room operations
re-check that ACL, so Project revocation immediately removes Room access. A
Room's optional Project Folder binding is fixed at creation and governed by
the normal read-only sandbox boundary (`architecture/EXECUTION_MODEL.md`).

## Per-message identity

The instructing human for a Room-dispatched run is resolved from the
triggering message's sender, never from the Room or a stored group owner
(ADR 0002). `RoomService.sendMessage` opens a fresh `agent_run_group` per
message with `manager_user_id` set to the current speaker; the run created for
that dispatch carries that speaker's `instructed_by_user_id`. This is a
security boundary, not a convenience: `instructed_by_user_id` is the retrieval
viewer identity, and it determines whose CLI credential capacity a
conversation backend spends (`modules/agents.md`, ADR 0008).

## Conversation backend

Each Room recipient resolves a `Space × room_recipient work scope × user ×
Agent` CLI binding from the speaker's own credential grants — never a
space-shared profile. Runtime Context owns its vendor-cache session and
acknowledged Event cursor; the Room session remains canonical conversation
storage, not the CLI binding identity. See `modules/agents.md` for the shared
direct-chat/Room execution model.

## API Surface

- `POST /api/v1/rooms` — create a Room (writer authority on the Project)
- `GET /api/v1/rooms` — list Rooms, optional `project_id` filter
- `GET /api/v1/rooms/:roomId` — Room detail with rosters
- `POST /api/v1/rooms/:roomId/conversations` — open a durable conversation
- `GET /api/v1/rooms/:roomId/conversations` — list conversations
- `GET /api/v1/rooms/:roomId/conversations/:sessionId/messages` — paged history
- `POST /api/v1/rooms/:roomId/conversations/:sessionId/messages` — send a
  message; supports direct `@agent` recipient segmentation or manager
  coordination, and optional explicit per-recipient backend selection

## Invariants

- Room membership never widens Project authority.
- Project-originated Room navigation stays inside the Project Shell. The
  Project sidebar and Overview link use `/projects/:projectId/rooms`; the
  global `/rooms` route remains the cross-Project index, not a second Room
  implementation.
- A Room does not turn `agent_run_groups` into a conversation container; each
  message is its own collaboration task.
- The vendor CLI runtime session, when resumed, is permitted runtime state and
  never a source of truth — agent-space retains full replay capability (ADR 0004).
