# Module: Product Shell

## Status
**IMPLEMENTED** — `apps/web/src/core/Shell.tsx`.

## Purpose
The persistent application frame: space-aware chrome, two-tier navigation,
quick capture, and account controls.

## Owns
- Top-level layout (`Shell.tsx`)
- Space switcher (`SpaceSwitcher`)
- Global rail and mobile tab bar (`RAIL_ITEMS` / `MOBILE_TAB_ITEMS` in
  `src/core/navigation.tsx`)
- Scene sidebar / scene tabs (`SceneSidebar`, `SceneTabs`)
- Floating capture (`FloatingQuickCapture`)
- User menu, theme toggle, logout
- Browser-local UI locale (`en` default, `zh-CN` available), changed in Settings or on public authentication pages and shared across tabs

## Does Not Own
- Page content (feature modules)
- Space or user data
- Proposal apply logic

## Current navigation

Rail (from `navigation.tsx`): Home · Agent Work · Command Center · Inbox · Reading ·
Source settings · Review · Knowledge · Shared · Tasks · Projects · Agents ·
Evolution · Instance Settings (instance admin) · Space Settings (space
admin) · Settings.

The mobile tab bar is the short daily subset: Home · Agent Work · Projects · More. Command Center is also available in More. Static shell and
navigation labels are translated through `apps/web/src/i18n/`; route IDs, Space
scope, and permission gates remain language-independent.

The Agents scene includes a distinct Skills link (`/skills`, “技能库” in
Chinese), alongside the legacy Capabilities link. Both desktop sidebar and
mobile scene tabs use `SCENES` in `navigation.tsx`; registering a module in
`registry.ts` alone does not add it to this navigation. The Skills route keeps
the Agents scene active after navigation.

Knowledge has no scene sidebar; sub-areas switch via
`KnowledgeSectionHeader`. There is no `CommandPalette`, Project Folder
switcher, or `RuntimeStatusBar`.

Shell chrome (rail, scene sidebar, header and tabs, mobile tab bar, floating
capture) and the Project area's navigation and side chat are wrapped in
`data-shell-chrome` (`display: contents`, so layout is unchanged). The Reader's
focus mode sets `html[data-reader-focus]`, which hides exactly those; the
Reader removes it when focus mode ends or the Reader unmounts.

## Related Files
- `apps/web/src/core/Shell.tsx`
- `apps/web/src/core/navigation.tsx`
- `apps/web/src/components/shell/`
- `apps/web/src/modules/registry.ts`
- `apps/web/src/i18n/`

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
- [0005-desktop-runtime.md](../decisions/0005-desktop-runtime.md)

## Authentication surfaces

`/login`, `/register`, `/invitations/claim`, and `/reset-password` are public
routes outside the authenticated shell. `/settings/security` is an authenticated
user surface inside the shell, with the Settings rail entry remaining available;
`/instance-settings` contains the instance-admin Users & Security
panel. A protected route always redirects unauthenticated users to `/login` and
does not render product data while auth context is loading.

Agent Work is a personal module at `/agent-work`, under RequireAuth, with a Global
Rail entry and an explicit Home button. It never registers a Space-prefixed route
and is a mobile primary tab. Its page owns selection, expansion, scroll and drafts. Shell mounts the account-keyed
`AgentAttentionProvider`, which owns the authorized personal aggregate stream and
mounted filter windows. Global Rail shows an accessible red dot when needs-you
or unread work is nonzero; Home exposes needs-you/unread-work counts;
Agent Work exposes freshness and explicit, default-off sound/desktop controls.
Sound/system delivery uses per-user Web Locks/BroadcastChannel. A visible in-app
toast broadcasts its revision identity to other same-account tabs, clearing their
pending copy and suppressing later duplicate display. Near-simultaneous arrivals
in two visible windows remain best-effort until that broadcast arrives. Foreground
replay skips only works known as read in a settled single-page shared-store window;
multipage/unstable windows intentionally retain pending reminders. Hidden arrivals remain pending until
visible unless already toasted elsewhere; a hidden leader does not consume them.
Without coordination, in-app deduplication is local to one tab. Background desktop
notifications and later in-app toasts remain two explicit channels.
A live connection is retained on foreground return. Capability degradation and
logout cleanup remain explicit; see [Agent Attention](agent-attention.md#global-aggregation-and-delivery).
The provider owns no message store, per-Run content stream or execution path.

On mobile, More exposes the remaining rail destinations and enabled plugin links,
with the same Space/instance admin visibility gates. Review attention remains
visible on More; Agent Work reuses the personal attention badge. The menu uses
the shared accessible dialog, closes on selection, and scrolls within the viewport.


Settings ends with Application version: a per-build identifier embedded in the
running JS and emitted as `/version.json`. Checks fetch the same-origin manifest
with no-store and compare IDs (not ordering); failures never report current.
Nginx and Workbox do not cache this manifest. Update requests the existing SW
registration to update and waits for activation before reloading; main.tsx remains
the sole registration/automatic reload owner. Development uses a per-Vite-process
ID. Builds have distinct IDs even when made from the same commit.
An opt-in layout diagnostic text area exposes build, browser, display mode,
viewport/screen/scroll geometry and resolved safe insets, with no account,
conversation, URL or workspace content. It is not transmitted automatically.


Reading keeps its route/module identity `library`. The shared desktop/mobile
scene offers To read, Read, All material, Daily editions and legacy By type
routes. Query-based views select the matching scene item. Project navigation
labels its existing Sources Area Reading; the page distinguishes Project reading
from My reading. Home adds only a preferred-Space preview of the same reading API.
