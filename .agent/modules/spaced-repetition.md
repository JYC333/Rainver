# Module: Spaced Repetition

## Current fact
- Schema: `cards`, `card_review_states`, `card_reviews` in
  `server/src/db/schema/cards.ts`. No server module and no runtime SQL.
- Knowledge › Cards does not schedule reviews (`KnowledgeCardsPanel`).
  Standalone `/cards` is registered `enabled: false`, `visible: false`.
- A separate `learning` HTTP module exists; the web client does not call
  `learningApi`. Project `/learning` redirects to Pulse.
