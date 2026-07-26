# Module: Spaced Repetition

## Status
**PLANNED** — not yet implemented. This doc defines intended design.

## Purpose
Anki-like review system. Cards are generated from knowledge items and activities. Review scheduling is personal — the same knowledge item can generate cards for multiple users, but review history is private. The mobile experience is the primary review surface.

## Owns
- `FlashCard` model (planned; named Card in earlier drafts)
- `CardReview` model (planned)
- Review scheduling (FSRS algorithm)
- Card generation from KnowledgeItems and ActivityRecords
- Review queue API
- Review UI (web + mobile — swipe gestures on mobile)

## Does Not Own
- Knowledge item content (knowledge-base module)
- Activity records (activity-inbox module)
- Proposal approval (proposals module)
- Media card rendering for rich types (media-cards module)

## Key Models (Planned)

```
FlashCard:
  id, space_id, user_id, project_folder_id
  knowledge_item_id        — FK → KnowledgeItem (null if standalone)
  activity_record_id       — FK → ActivityRecord (null if not from activity)
  front, back, extra
  card_type (basic|cloze|image|audio)
  status (active|suspended|archived)
  next_review_at           — computed by FSRS after each review
  created_at

CardReview:
  id, card_id, user_id
  reviewed_at
  rating (again|hard|good|easy)   — FSRS input
  scheduled_days                  — days until next review
  due_at                          — absolute datetime of next due date
  fsrs_state_json                 — full FSRS algorithm state blob
```

## FSRS Algorithm

Uses [FSRS v5](https://github.com/open-spaced-repetition/fsrs4anki) for memory-optimized scheduling.

- State stored per-card per-user in `fsrs_state_json`
- On each review: compute new stability, difficulty, retrievability
- Output: `scheduled_days` → `FlashCard.next_review_at = now + scheduled_days`
- Grades: `again=1, hard=2, good=3, easy=4`

FSRS must be a pure function over `(fsrs_state, rating, elapsed_days)` — no side effects. State is stored in the DB; algorithm is stateless library code.

## Card Generation Flow

```
New KnowledgeItem or ActivityRecord created/approved
    ↓
Card generation agent analyzes content
    ↓
Proposes new FlashCard(s) via Proposal
    ↓
User approves (or auto-approve if trusted source + config allows)
    ↓
FlashCards created with status=active, next_review_at=now
    ↓
Cards enter review queue
    ↓
User reviews on due date → CardReview created → FSRS state updated
    ↓
FlashCard.next_review_at updated
```

## Review Queue API (Planned)

```
GET /api/v1/cards/due?space_id=...&limit=20
  → Returns FlashCards where next_review_at <= now, status=active
  → Ordered by next_review_at asc (most overdue first)

POST /api/v1/cards/{id}/review
  body: { rating: "again"|"hard"|"good"|"easy" }
  → Creates CardReview, updates FlashCard.next_review_at
```

## Sharing Model

- **Knowledge is shareable**: A KnowledgeItem in a space can generate cards for multiple users
- **Review state is personal**: Each user has their own CardReview history and FSRS state
- **Cards are per-user**: A FlashCard is created per user, not per knowledge item — two users in the same space have independent card copies

## UI: Review Session (Web)

- Card shown full-screen (center panel)
- "Show answer" button reveals back
- Grade buttons: Again / Hard / Good / Easy
- Progress bar: X of N due today
- Keyboard shortcuts: space=reveal, 1=again, 2=hard, 3=good, 4=easy
- Session stats: cards reviewed, time spent, accuracy

## UI: Review Session (Mobile)

- Full-screen card view
- Tap anywhere to reveal back
- Swipe left = Again, swipe right = Easy
- Tap Hard / Good buttons below card
- Swipe-based flow designed for one-handed use
- Pre-fetches next 20 cards for offline review (IndexedDB cache)

## UI: Card Browser

- List of all FlashCards for current space/user
- Filter by: status, source (knowledge/activity), Project Folder, due date
- Bulk actions: suspend, archive, reset scheduling
- Each row: front preview, due date, FSRS difficulty, review count

## Invariants
- Review history is private to the user — never cross-user readable
- Cards are generated from approved content (KnowledgeItems or ActivityRecords)
- Direct card writes by agents require proposals
- FSRS state must not be shared between users
- `next_review_at` is always set; a new card with no reviews has `next_review_at=created_at` (due immediately)
- Cards are never deleted — status transitions to `suspended` or `archived` instead

## Related Files
- `server/migrations/` — TODO: add FlashCard/CardReview tables
- `server/src/modules/` — TODO: review queue + FSRS module
- `server/src/modules/<cards>/routes.ts` — TODO: review API
- `apps/web/src/pages/` — TODO: review session page
- `apps/web/src/components/ReviewCard.tsx` — TODO: card component (swipe support)

## Related Modules
- [knowledge-base.md](knowledge-base.md) — primary source of card content
- [activity-inbox.md](activity-inbox.md) — secondary source (captures → cards)
- [media-cards.md](media-cards.md) — rich-media card extension
- [proposals.md](proposals.md) — card generation always goes through proposals
- [mobile-client.md](mobile-client.md) — mobile is primary review surface

## TODO
- FlashCard and CardReview models
- FSRS implementation or integration (open-source FSRS library)
- Card generation capability
- Review API endpoints
- Frontend review UI (web + mobile, with swipe gestures)
