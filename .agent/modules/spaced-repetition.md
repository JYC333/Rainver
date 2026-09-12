# Module: Spaced Repetition

## Status
**NOT IMPLEMENTED** as a product surface.

## Current fact
- Schema: `cards`, `card_review_states`, `card_reviews` in
  `server/src/db/schema/cards.ts`. No server module and no runtime SQL.
- Knowledge › Cards is an empty-state placeholder
  (`KnowledgeCardsPanel`). Standalone `/cards` is registered
  `enabled: false`, `visible: false`.
- A separate `learning` HTTP module exists; the web client does not call
  `learningApi`. Project `/learning` redirects to Pulse.

Design notes: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §3.
