# Module: Spaced Repetition

## Current fact
- Schema: `cards`, `card_review_states`, `card_reviews` in
  `server/src/db/schema/cards.ts`. No server module and no runtime SQL.
- Knowledge › Cards does not schedule reviews (`KnowledgeCardsPanel`).
  Standalone `/cards` is registered `enabled: false`, `visible: false`.
- A separate `learning` HTTP module exists; the web client does not call
  `learningApi`. Project `/learning` redirects to Pulse.

## Learning core commands

The separate Learning module retains POST objectives, items and item review as
`learning.objective.create`, `learning.item.create`, and `learning.item.review`.
They are keyed human commands with strict protocol schemas and typed clients.
LearningService's actual writers join `withQueryableTransaction`; admission
uses the existing Source release closure to discover and lock all destination,
objective, Knowledge Project/share/Folder/grant dependencies before person and
roots, and refuses scope drift. Creation retains Project writer and current
shared-Knowledge read/version authority; mastery remains private per person
under current Project read authority. Domain state, required audit and receipt
commit together. Cached results recheck those same current authorities and
never increment mastery again. No Card scheduler or active Memory writer is
introduced.
