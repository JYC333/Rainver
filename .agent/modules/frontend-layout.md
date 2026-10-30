# Module: Frontend Layout

## Status
**IMPLEMENTED** — rail + optional scene sidebar + main outlet. Not a
generic three-panel `PanelLayout`.

## Purpose
Describe the layout the web app actually uses.

## Current pattern

```
┌─────────────────────────────────────────────────────────────┐
│  Shell: SpaceSwitcher · theme · user menu                   │
├────────┬────────────────────────────────────────────────────┤
│ Global │  Scene sidebar (some routes) · main <Outlet>       │
│ Rail   │  Project sidecar chat on Project routes (≥ lg)     │
│        │  Floating capture                                   │
├────────┴────────────────────────────────────────────────────┤
│  Mobile: bottom tab bar + scene tab strip                   │
└─────────────────────────────────────────────────────────────┘
```

Below the `md` rail breakpoint, Home and Space Today stack their
300px aside under the main column (`.page-dashboard`). The bottom tab
bar is Home · Agent Work · Projects · More. Command Center remains on the desktop rail and is available in mobile More.

Home is user-scoped (`/home`). Space routes are
`/spaces/:spaceId/<module>`. Admin-only modules are wrapped at the route.

There is no app-level right inspector, bottom log panel, or shared
`EntityCard` / `ReviewCard` primitive set. Per-page inspectors (Run
detail, Room sidecar) are owned by those pages.

## Related Files
- `apps/web/src/core/Shell.tsx`
- `apps/web/src/core/navigation.tsx`
- `apps/web/src/components/shell/`

## Related Modules
- [product-shell.md](product-shell.md)


Agent Work owns a list/detail grid at user-level `/agent-work`. Below `md`, opening
a detail hides the mounted list, and Back preserves local filters and list scroll.
It adds no app-level inspector.

The Project Room page stacks navigation, conversation and Project state below
`lg` in an explicit `minmax(0, 1fr)` grid column. This prevents a long truncated
workspace name in navigation from widening the conversation behind Shell's
scrolling viewport. At `lg` and `xl` it uses its existing two/three columns.

Notes and Files & Code share `components/ui/document-tab.tsx` for the curved
tab silhouette and active/hover/close treatment. CodeMirror stays specific to
Files & Code, with global theme tokens and live light/dark reconfiguration.

On mobile, More exposes the remaining rail destinations and enabled plugin links,
with the same Space/instance admin visibility gates. Review attention remains
visible on More; Agent Work reuses the personal attention badge. The menu uses
the shared accessible dialog, closes on selection, and scrolls within the viewport.

The authenticated Shell is fixed to the dynamic viewport with a shrinkable main
scroll area; the document does not scroll behind its bottom navigation. Mobile
Agent Work uses an accessible red dot only when unread/needs-you is nonzero,
on both the desktop rail (collapsed or expanded) and mobile bottom navigation.
Project conversation history contains scroll chaining; mobile conversation cards
use dynamic viewport height instead of the desktop 640px minimum.

At `lg` and above, ProjectAreaLayout fills the Shell content height: its Project
navigation and Area content each own a bounded, contained vertical scroller.
Scrolling Area content does not move the Project navigation, and long navigation
remains independently reachable. Below `lg`, Project navigation starts as a compact expandable row so Area content appears first; the full navigation remains reachable and collapses after selecting a destination.
Project navigation and Files & Code separators explicitly use `border-border`
rather than inheriting the text color.

The Project Board uses a minimum page height rather than a fixed `h-full`, so
lanes grow to enclose their full card lists. Long Boards scroll in the Area
content while Project navigation remains independent; horizontal lane overflow
is retained and cards are not clipped by individual lane scroll containers.


## Topic (goal) routes

Personal topics live at `/library/reading/goals[/new|/:goalId]` and Project
topics at `/projects/:projectId/sources/goals[/new|/:goalId]` inside the Project
layout; `/sources/access` remains the dedicated credential route. Source
list/detail and Project Sources/settings links carry scope into the same page.
The create page is a single centered form (topic, frequency, effort, folded
Advanced). The topic page is a two-column grid at `lg` and above — the update
stream in a `minmax(0,1fr)` column and a 20rem status/changes/manage aside with
a bordered card surface — and stacks the aside below the stream on narrow screens. The
plan conversation, trial and Agent settings sit in a folded Advanced section
below both columns, where the conversation and plan share a two-column grid only
at `xl`. Selection toggles use the shared muted segmented style with
`aria-pressed`; status uses a polite live region. No independent chat engine or
new navigation platform is introduced.

Goal composer draft persistence is an opt-in predicate on the shared draft hook:
recognized secret patterns clear older session storage before another write.
Other conversation consumers keep their existing persistence behavior. Topic
creation keeps only its idempotency key and created id in session storage, never
the topic text. Legacy channel deep links first resolve existing mappings
read-only. Owned source list/detail controls route to topic management. Error
guidance is categorized and localized; budget/credentials/stopped errors do not
suggest blind Agent retries.
