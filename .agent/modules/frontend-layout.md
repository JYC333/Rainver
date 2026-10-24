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
remains independently reachable. Below `lg` the existing stacked layout remains.
Project navigation and Files & Code separators explicitly use `border-border`
rather than inheriting the text color.

The Project Board uses a minimum page height rather than a fixed `h-full`, so
lanes grow to enclose their full card lists. Long Boards scroll in the Area
content while Project navigation remains independent; horizontal lane overflow
is retained and cards are not clipped by individual lane scroll containers.
