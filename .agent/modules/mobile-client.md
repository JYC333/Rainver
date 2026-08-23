# Module: Mobile Client

## Status
**PLANNED** — PWA scaffold exists (Vite + manifest). Mobile-specific UI not built.

## Purpose
Define the mobile client strategy. agent-space targets mobile as a thin client for capture, review, and consumption — not as a full agent execution environment. Mobile is a first-class surface for quick capture (thoughts, life logs), card review, and proposal approval, not for running agents or editing Project Folders.

## Owns
- PWA manifest and service worker (offline shell)
- Mobile layout variants (single-column, bottom nav, drawer panels)
- Quick capture interface (one-tap thought capture)
- Offline queue for captures (sync when back online)

## Does Not Own
- Agent run execution (server-side, or on a registered execution host acting on the control plane's behalf — see [decisions/0016-control-plane-execution-hosts.md](../decisions/0016-control-plane-execution-hosts.md); mobile never executes agent code locally either way)
- Project Folder file editing (desktop / web only in v1)
- Full memory review governance UI (mobile shows simplified view)

## Target Surfaces

| Surface | Mobile Experience | Priority |
|---|---|---|
| Quick capture | Full — bottom sheet, one tap | P0 |
| Card review | Full — swipe gestures for grades | P0 |
| Activity inbox | Read + triage (archive, mark reviewed) | P1 |
| Proposal review | Accept/reject with one tap | P1 |
| Memory list | Read-only browse | P2 |
| Knowledge read | Read + highlight | P2 |
| Agent chat | Full (text-only, no file attach in v1) | P2 |
| Files & Code | Not supported in v1 | — |
| Diff review | Not supported in v1 | — |

## Layout on Mobile

```
┌─────────────────────┐
│ Top: Space switcher  │
│      + page title    │
├─────────────────────┤
│                     │
│  Content (full)     │
│                     │
│                     │
├─────────────────────┤
│ Bottom nav:         │
│ Today | Review |    │
│ Capture | Inbox |   │
│ More (drawer)       │
└─────────────────────┘
```

Left and right panels (from desktop layout) become:
- Left panel → slide-in drawer from left
- Right panel → bottom sheet or slide-in from right

## Quick Capture

- Floating action button (FAB) always visible
- Tap → bottom sheet with text input, type selector (thought / idea / reflection)
- Submit → creates `ActivityRecord(type=..., source=manual)` via API
- Offline: stored in IndexedDB queue, synced when connection restored
- Must complete in < 3 taps from any screen

## Card Review on Mobile

- Full-screen card view
- Swipe left = Again, swipe right = Easy, tap = reveal
- Horizontal swipe for Hard/Good (customizable)
- Session progress bar at top (X of N cards)
- Works offline: pre-fetch next 20 cards on load

## Offline Behavior

| Feature | Offline Behavior |
|---|---|
| Quick capture | Queued in IndexedDB, synced on reconnect |
| Card review | Pre-fetched cards reviewed offline; grades synced |
| Activity inbox | Cached last-seen list; reads work; writes queued |
| Proposal approval | Queued; applied on reconnect |
| Memory browse | Cached last-seen list; reads work |
| Agent chat | Requires connection — show offline indicator |

## PWA Requirements

- `manifest.json`: name, short_name, icons (192px + 512px), start_url, display=standalone
- Service worker: cache shell + static assets; cache API responses with stale-while-revalidate
- Install prompt: shown after 3 sessions (or on explicit "Add to Home Screen" button)
- Background sync: Web Background Sync API for offline queue drain

## Invariants
- Mobile never runs agent code locally — all agent execution runs on the control plane's server host or a registered execution host, never on the client
- Quick capture must work offline (no error if server unreachable)
- Card review must pre-fetch to work without continuous connection
- Mobile layout must be a variant of desktop layout components — not a separate app
- Bottom navigation covers the 4 most common actions; all other nav via "More" drawer

## Related Files
- `apps/web/public/manifest.json` — TODO: PWA manifest
- `apps/web/src/service-worker.js` — TODO: service worker
- `apps/web/src/App.tsx` — TODO: mobile layout detection + routing
- `apps/web/src/components/` — TODO: MobileLayout, FAB, BottomNav, SwipeCardReview

## Related Modules
- [frontend-layout.md](frontend-layout.md) — desktop layout that mobile adapts
- [product-shell.md](product-shell.md) — shell chrome on mobile
- [spaced-repetition.md](spaced-repetition.md) — card review (mobile primary surface)
- [activity-inbox.md](activity-inbox.md) — quick capture feeds activity inbox
- [sync-and-conflicts.md](sync-and-conflicts.md) — offline queue sync strategy
- [client-server-protocol.md](client-server-protocol.md) — API mobile uses
