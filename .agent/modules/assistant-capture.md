# Module: Assistant Capture

## Status
**PLANNED** — not yet implemented. This doc defines intended design.

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

## Main Flow (Planned)

```
User submits capture (text, voice, URL, paste)
    ↓
API creates ActivityRecord(type=thought|life_log|...)
    ↓
Memory Curator agent analyzes (async, in background)
    ↓
Agent proposes: memory update, knowledge item, card, or task
    ↓
User reviews and approves proposals
    ↓
Proposals activate into memory / knowledge / cards
```

## Invariants
- Capture always creates an ActivityRecord first — never writes directly to memory
- Context-free capture always lands in the user's Personal Space; browsing a team Space does not
  change the destination and there is no persisted write-target mode.
- Voice notes must be transcribed before being stored as raw_content
- Browser extension must not store captured data locally — always POST to server
- Captured chat transcripts are treated as ActivityRecord(type=chat_capture), not as memories

## Related Files
- `server/migrations/` — ActivityRecord tables
- `server/src/modules/agents/` — assistant agent/template behavior
- `server/src/modules/memory/` — memory proposal/reflection behavior
- `apps/web/src/pages/` — TODO: capture UI

## TODO
- ActivityRecord model
- Quick capture API endpoint
- Browser extension (long-term)
- Voice transcription integration
