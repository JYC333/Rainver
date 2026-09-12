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
Review · Tasks. Command Center remains a rail destination.

Knowledge has no scene sidebar; sub-areas switch via
`KnowledgeSectionHeader`. There is no `CommandPalette`, Project Folder
switcher, or `RuntimeStatusBar`.

## Related Files
- `apps/web/src/core/Shell.tsx`
- `apps/web/src/core/navigation.tsx`
- `apps/web/src/components/shell/`
- `apps/web/src/modules/registry.ts`

## Related Decisions
- [0001-space-model.md](../decisions/0001-space-model.md)
- [0005-desktop-runtime.md](../decisions/0005-desktop-runtime.md)

Unimplemented chrome ideas: [unimplemented-from-guides.md](../plans/unimplemented-from-guides.md) §1.
