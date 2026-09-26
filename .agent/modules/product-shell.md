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

Rail (from `navigation.tsx`): Home · Command Center · Inbox · Library ·
Sources · Review · Knowledge · Shared · Tasks · Projects · Agents ·
Evolution · Instance Settings (instance admin) · Space Settings (space
admin) · Settings.

The mobile tab bar is the short daily subset: Home · Inbox · Library ·
Review · Tasks. Command Center remains a rail destination. Static shell and
navigation labels are translated through `apps/web/src/i18n/`; route IDs, Space
scope, and permission gates remain language-independent.

Knowledge has no scene sidebar; sub-areas switch via
`KnowledgeSectionHeader`. There is no `CommandPalette`, Project Folder
switcher, or `RuntimeStatusBar`.

## Related Files
- `apps/web/src/core/Shell.tsx`
- `apps/web/src/core/navigation.tsx`
- `apps/web/src/components/shell/`
- `apps/web/src/modules/registry.ts`
- `apps/web/src/i18n/`

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
- [0005-desktop-runtime.md](../decisions/0005-desktop-runtime.md)

Unimplemented chrome ideas: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §1.
## Authentication surfaces

`/login`, `/register`, `/invitations/claim`, and `/reset-password` are public
routes outside the authenticated shell. `/settings/security` is an authenticated
user surface inside the shell, with the Settings rail entry remaining available;
`/instance-settings` contains the instance-admin Users & Security
panel. A protected route always redirects unauthenticated users to `/login` and
does not render product data while auth context is loading.
