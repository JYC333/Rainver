# Module: Media Cards

## Status
**PLANNED** — No backend model yet. Spaced repetition module exists but media-card extension not built.

## Purpose
Extend the spaced repetition card system to support rich-media cards: image occlusion, audio cards, video clips, screenshot annotations. Media cards are a distinct card type layered on top of the core `FlashCard` / `ReviewItem` model.

## Owns
- Media card type definitions (image, audio, video, screenshot)
- Media file storage references (not the files themselves)
- Media card creation UI (annotation, cropping, occlusion mask)
- Media card review UI (reveal + FSRS grading)

## Does Not Own
- Core FSRS scheduling (spaced-repetition module)
- File storage / CDN (future storage module)
- Card generation from knowledge or memory (spaced-repetition module)

## Card Types

| Type | Front | Back | Use Case |
|---|---|---|---|
| `image_occlusion` | Image with masked region(s) | Image fully revealed | Anatomy diagrams, maps, charts |
| `audio_cloze` | Audio clip with pause | Reveal word/phrase | Language learning, dictation |
| `screenshot_note` | Screenshot with annotation highlight | Full context revealed | Code snippets, UI references |
| `video_clip` | Short video (muted or with audio) | Key frame + caption | Procedural learning |

## Key Model (Planned Extension)

```
MediaCard:
  id, space_id, user_id, project_folder_id
  base_card_id    — FK → FlashCard (null if standalone)
  type            — image_occlusion | audio_cloze | screenshot_note | video_clip
  media_url       — reference to stored file
  media_metadata  — {width, height, duration, format}
  occlusion_masks — [{x, y, w, h, label}]  (for image_occlusion)
  transcript      — optional text transcript (for audio/video)
  created_at
```

## Creation Flow

```
User uploads image / audio / video
    ↓
Media stored (local path or object storage reference)
    ↓
MediaCard record created with media_url
    ↓
For image_occlusion: user draws mask(s) in UI
    ↓
For audio_cloze: user marks cloze timestamps
    ↓
Card linked to FlashCard (gets FSRS scheduling)
    ↓
Appears in review queue
```

## Review Flow

- Same FSRS queue as text cards — no separate queue
- Renderer checks `type` and renders accordingly
- Grading buttons: Again / Hard / Good / Easy (same as text cards)
- For image_occlusion: front = image with mask overlaid; back = mask removed

## UI Sections

**Media card creator:**
- Upload area (drag-and-drop or file picker)
- Preview with annotation tools (mask draw, highlight)
- Transcript input for audio/video
- Save → creates MediaCard + FlashCard

**Review renderer:**
- Detects card type; renders image/audio/video player
- Occlusion overlay drawn with SVG or canvas
- Reveal button removes overlay
- FSRS grade buttons below

## Invariants
- Every MediaCard must be linked to a FlashCard (or create one on save)
- `media_url` references storage — never embeds raw binary in the DB
- Occlusion masks are stored relative to image dimensions (0–1 normalized)
- Audio/video review always offers a text transcript fallback

## Related Files
- `server/migrations/` — TODO: add MediaCard table
- `server/src/modules/` — TODO: extend with media endpoints
- `apps/web/src/pages/` — TODO: media card creator and review renderer

## Related Modules
- [spaced-repetition.md](spaced-repetition.md) — core FSRS scheduling
- [knowledge-base.md](knowledge-base.md) — cards generated from knowledge items
- [activity-inbox.md](activity-inbox.md) — file_import activity type
