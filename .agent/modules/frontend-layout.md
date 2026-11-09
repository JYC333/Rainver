# Module: Frontend Layout

## Status
**IMPLEMENTED** — rail + optional scene sidebar + main outlet. Not a
generic three-panel `PanelLayout`.

## Purpose
Describe the layout the web app actually uses. Visual styling and review follow
[UI Style Guide](../architecture/UI_STYLE_GUIDE.md), including shared controls,
card action hierarchy, theme tokens and entry-level browser acceptance.

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
It adds no app-level inspector. Command Center's Hosts use the same page-owned
list/detail, with the selected Host in `?host=` (see `modules/hosts.md`,
"Command Center layout").

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

The Project Board fills the available Area height on desktop and mobile. Each
lane scrolls its card list independently while its controls and completed-task
expansion stay visible. Horizontal lane scrolling stays at the bottom of the
visible Board. A portalled drag overlay keeps card and column previews outside
the scroll clips. Mobile Project navigation has its own bounded expansion.


## Topic (goal) routes

Personal topics live at `/library/reading/goals[/new|/:goalId]` and Project
topics at `/projects/:projectId/sources/goals[/new|/:goalId]` inside the Project
layout; `/sources/access` remains the dedicated credential route. Source
list/detail and Project Sources/settings links carry scope into the same page.
The create page is a single centered form (topic, frequency, effort, folded
Advanced). Each topic detail is a single-column management page at every width:
status and current checks, the effective direction, Sources and their execution
state, recent collection audits, a scoped Reading link and management. It does
not repeat the article stream. The Project's existing navigation/chat sidecar
may still surround it; the topic itself never adds another side column.

One Adjust following button opens a wide shared dialog (full-screen on phones).
Direct edit and Discuss changes are tabs in the same single-column surface.
Both stay mounted while switching tabs, so an unsaved form and a conversation
draft are retained. This dialog opts into the shared draft hook’s guarded
unmount flush, so closing within its 250ms debounce retains the last input;
a changed session epoch prevents a post-logout flush. The form freezes its original expected revision; polling
cannot silently rebase it. Conversation tools, plan details and optional trials
are folded above the flex-bounded conversation, whose composer stays visible.
Pending-plan confirmation moves into the dialog while it is open, preserving
the same explicit follow action and Project analysis consent. Closing returns
keyboard focus and neither applies a draft nor cancels a running operation.
Status remains a polite live region; Source change confirmation still uses its
existing exact-revision dialog. No new chat engine or route is introduced.

Goal composer draft persistence is an opt-in predicate on the shared draft hook:
recognized secret patterns clear older session storage before another write.
Other conversation consumers keep their existing persistence behavior. Topic
creation keeps only its idempotency key and created id in session storage, never
the topic text. Legacy channel deep links first resolve existing mappings
read-only. Owned source list/detail controls route to topic management. Error
guidance is categorized and localized; budget/credentials/stopped errors do not
suggest blind Agent retries.

## Problem workspace

Project navigation labels the Inquiry route as Problems / 问题推进 and removes
the duplicate Research sidebar entry. `problemWorkspace/ProblemAreaPage.tsx`
composes purpose-specific definition/work/Task/Research/closeout/history modules;
it does not add another page-wide orchestrator. Shared controls and theme tokens
are reused. Stage/section navigation preserves browser history without writes.
Legacy Research routes canonicalize via `researchPageDestination` before the
old navigation is removed; records and report object context stay reachable.
See [domain guide](../architecture/INQUIRY_PROBLEM_ENGINE.md#project-local-workspace-p5).

The Problems header also opens the existing Project Standing panel at
`section=standing`; old `research?tab=standing` links resolve there. Budget,
source inflow, advice and retry remain reachable without creating a Thread.

Only settings child pages have a compact, wrapping navigation row within the
main scroller, before the page. It contains only the shared Button link back to
the settings parent, without an additional icon or breadcrumb trail. The three settings
roots have no extra navigation row or Home button.
The mobile row remains available when Global Rail is hidden; desktop and mobile
More use the same settings ownership/highlight rules.
