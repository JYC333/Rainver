# Module: Assistant Capture

## Status
**PARTIAL** — the capture entry and its four destinations are implemented
(`server/src/modules/capture/`, `apps/web/src/components/FloatingQuickCapture.tsx`).
The assistant chat, voice, and browser-extension surfaces below are still
intended design.

## Purpose
Personal assistant and quick-capture module. Records thoughts, ideas, life events, and reflections as they happen. Raw input becomes an ActivityRecord first — not active memory.

## Owns
- Quick capture UI (text, voice note, image)
- Browser extension / clipboard capture (planned)
- ActivityRecord creation for capture events
- Personal assistant chat interface (planned)

## Does Not Own
- Long-term memory storage (memory module)
- Activity-to-proposal pipeline (activity module)
- Card generation (spaced-repetition module)

## Capture Types

| Type | Example |
|---|---|
| Thought | "I want to learn Rust" |
| Life log | "Had lunch with the team" |
| Idea | "What if we added X feature" |
| Reflection | "Today I noticed I work better in the morning" |
| Chat import | Paste/import from external chat |
| URL clip | Save a web article for later processing |

## Destinations

One floating composer serves every page and posts to `POST /api/v1/captures`.
Outside a Project the only destination is the personal inbox; inside one there
are four. Ownership and pipeline are separate axes (ADR 0013 amendment 3b):

| Destination | Scope | Visibility | Pipeline |
|---|---|---|---|
| `object_marginalia` | the Project | `private` | projected into a note |
| `project_marginalia` | the Project | `private` | projected into a note |
| `project_raw` | the Project | `space_shared` | stays `raw` |
| `personal_inbox` | none | `private` | stays `raw` |

The default is inferred from **where the text came from**, not what it says: a
paste event or a URL defaults to Project raw material, hand-typed text to
marginalia. Both are deterministic, both are overridable in one click, and the
choice is never remembered across captures (ADR 0013 decision 2).

Marginalia lands in a per-user, per-target `private` note — the Project-level
one bound by `notes.marginalia_project_id` / `marginalia_owner_user_id`, the
object-level one by its `note_links` edge plus owner. Row-level visibility is
why there is one note per member rather than private blocks in a shared note.

## Main Flow

```
User submits capture (text, URL, paste) with a destination
    ↓
API creates ActivityRecord — always, for every destination
    ↓
marginalia?  ── yes ─→ projected into the caller's private note in the
    │                   same transaction; record marked `processed`
    no
    ↓
Record stays `raw`, awaiting processing
    ↓
Memory Curator agent analyzes (async, in background)  [planned]
    ↓
Agent proposes: memory update, knowledge item, card, or task
    ↓
User reviews and approves proposals
    ↓
Proposals activate into memory / knowledge / cards
```

## Invariants
- Capture always creates an ActivityRecord first — never writes directly to
  memory. This holds for the Project destinations too: marginalia is a
  projection of the record into a note, not a bypass of it.
- The personal-inbox destination always lands in the user's Personal Space;
  browsing a team Space does not change it and there is no persisted
  write-target mode.
- A marginalia note is one member's own. It is never displaced or shared by
  another member's capture, and it carries no `project_role` — a role is one
  note per Project by construction, which is the opposite of what marginalia
  needs.
- Voice notes must be transcribed before being stored as raw_content
- Browser extension must not store captured data locally — always POST to server
- Captured chat transcripts are treated as ActivityRecord(type=chat_capture), not as memories

## Related Files
- `server/src/modules/capture/` — the capture entry and its destinations
- `server/src/modules/knowledge/noteMarginalia.ts` — the note projection
- `server/src/modules/captureFiling/` — filing a personal capture into a Project
- `server/src/modules/agents/` — assistant agent/template behavior
- `server/src/modules/memory/` — memory proposal/reflection behavior
- `apps/web/src/components/FloatingQuickCapture.tsx` — the single capture entry
- `apps/web/src/contexts/CaptureContext.tsx` — how a Project
  and an Area declare what a capture may attach to

## Relocation and promotion

A capture can be moved or copied to another destination after the fact
(`GET`/`POST /api/v1/captures/:activityId/relocation`). Promotion — private
marginalia becoming team material — is the same mechanism seen from the other
end, which is what makes shipping marginalia as `private` affordable.

Anchoring is by `notes.attrs.blockId`, recorded on the capture's
`activity_record` at write time. An index would not survive the user inserting a
line above the block.

Authority follows ADR 0013 amendments 6a and 6b. **Move** needs the content's
owner, or — for a Project-scoped capture — the Project's owner or a Space
owner/admin; a capture with no Project is movable by its owner alone. Taking
*another member's* content out of the Space needs
`spaces.member_copy_out_enabled` (default off,
`PATCH /api/v1/spaces/{spaceId}/content-egress`); your own content is never
gated by it. Any crossing of a Space boundary — by either verb, to any
destination — announces itself to the other members as pointer metadata when
the Space has egress notifications on.

What counts as leaving is the *resolved destination Space*, not the destination
name: a Project destination takes its Space from the caller's `project_id`, so
`project_marginalia` can cross a boundary too.

The preview offers rather than decides: the anchored block is preselected and
the blocks after it, up to the next capture or heading, are listed unchecked.

## TODO
- Browser extension (long-term)
- Voice transcription integration
- File and image capture (the composer shows both as coming-soon)
