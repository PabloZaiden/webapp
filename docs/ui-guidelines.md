# UI guidelines

The framework intentionally provides a consistent base UI:

- Fixed sidebar header and main header share the same height.
- Sidebar content scrolls independently; the title row and footer stay fixed.
- Sidebar width is desktop-first and collapsible; mobile uses a drawer with backdrop.
- The app title in the sidebar navigates home.
- Settings and collapse controls are framework-owned.
- Version is always visible at the bottom of the sidebar.
- Main content should prefer panels, toolbars, badges and simple forms over custom one-off layouts.
- `WebAppRoot` owns the fixed main title bar and `.wapp-main-content`; app routes should not render or style those shell elements directly.

## Mobile breakpoint and viewport synchronization

The framework owns the mobile shell breakpoint. `MOBILE_BREAKPOINT_PX` and `MOBILE_MEDIA_QUERY` are exported from `@pablozaiden/webapp/web` for application JavaScript that needs to coordinate with the shell; do not add an independent `innerWidth` threshold for shell behavior. The generated document initializes the `data-wapp-mobile` marker on the root element before the client and styles load, and `WebAppRoot` keeps it synchronized with media-query changes. Custom CSS that follows the framework mobile mode should use that marker rather than repeating a numeric media query.

`WebAppRoot` follows `visualViewport` resize/scroll, window resize, orientation changes, focus boundaries, and mobile media-query changes. It schedules an immediate animation-frame sync first. Two named, bounded retries remain for mobile Safari/WebKit and Chromium behavior where focus/blur or orientation notifications can arrive before the final `visualViewport` geometry is available while the keyboard, browser chrome, or rotation is settling. The first retry catches the post-event layout pass; the final retry catches the end of that transition when no further geometry event is emitted. These retries are implementation fallbacks, not general synchronization primitives, and are cancelled with the associated animation frame and listeners when the root is unmounted.

The framework mobile mode is separate from the narrower `640px` settings-layout rules. Do not add global touch handlers or arbitrary sleeps to reproduce either behavior; use the framework drawer controls and the existing event-driven viewport lifecycle.

## Main content primitives

Use these first:

| Component | Use |
| --- | --- |
| `Page` | Required top-level wrapper for route content rendered by `WebAppRoot.routes`; provides standard margins/padding and mobile spacing |
| `Toolbar` | Page title/actions inside main content |
| `Panel` | Cards/sections; use `actions` for a top-right menu/action area |
| `ActionMenu` | Three-line action menu for secondary surfaces; entity-level shell menus should usually come from `SidebarNode.actions` so the framework renders them in the sidebar context menu and fixed title bar |
| `Button` / `IconButton` | Form submission and true inline controls; prefer action menus for entity/app commands |
| `Badge` | Status/count labels; sidebar badges render as compact colored dots to preserve sidebar width |
| `EntityHeader` | Main-content entity title/description/actions |
| `DataList` / `DataListRow` | Lists with title, description, metadata, badge and actions |
| `TextField`, `TextAreaField`, `SelectField` | Forms |
| `FormGroup`, `FormActions` | Grouped forms and aligned action rows |
| `DangerZone` | Destructive settings or entity operations |
| `LoadingState`, `ErrorState` | Loading and failure UI |
| `CodeValue` | Tokens, IDs, URLs and copyable code values |
| `SegmentedControl` | Small enum settings |
| `EmptyState` | Empty or missing content |
| `ConfirmDialog` | Destructive confirmation |

For entity actions, prefer the framework title bar: define one `ActionMenuItem[]` builder and attach it to `SidebarNode.actions` for the route-backed node. The framework reuses those actions for both sidebar right-click and the active route title-bar menu. Use `WebAppRoot.header.getActions` only for additional actions not owned by a sidebar node.

Every route component rendered by `WebAppRoot.routes` should return `Page` at the top level, including loading/error/empty states. Do not render a `Panel`, `DataList`, `EmptyState` or custom div directly into `WebAppRoot`; that skips the standard content margins and recreates the visual bug where cards touch the main content edge. Use `EntityHeader` only when the page needs a content-specific heading distinct from the fixed framework title bar; do not duplicate the active route title immediately below the header.

## Visual validation captures

Reference screenshots live in `artifacts/screenshots`:

| Capture | Purpose |
| --- | --- |
| `notes-desktop-light.png` | Realistic app, desktop shell |
| `notes-settings-desktop-light.png` | Framework settings |
| `notes-mobile-light.png` | Mobile shell |
| `notes-mobile-sidebar-light.png` | Mobile drawer/sidebar |
| `notes-desktop-dark.png` | Dark mode |
| `kitchen-desktop-light.png` | Kitchen sink desktop |
| `kitchen-mobile-light.png` | Kitchen sink mobile |
| `kitchen-sidebar-collapsed-light.png` | Collapsed sidebar title bar |
| `kitchen-context-menu-light.png` | Sidebar context menu |
| `kitchen-dialog-dark.png` | Confirm dialog overlay |
| `kitchen-device-light.png` | Device auth approval flow |

Use the temporary Playwright harness described in `skills/webapp/SKILL.md` when new visual captures are needed. Its default output is disposable; to intentionally update these checked-in reference captures, run the application-specific temporary harness with `PLAYWRIGHT_OUT_DIR="$PWD/artifacts/screenshots"` and review every changed image before committing it. Browser automation and screenshot capture must stay Playwright-based and cross-platform; do not hard-code local Chrome or OS-specific browser paths. The framework does not ship a screenshot command or Playwright dependency.

Use these captures as the manual visual baseline before changing shell, sidebar, settings or dialog styles. When screenshots are captured to validate a visual change, review them against the specific goal; capturing files without checking the result is not validation.

All destructive delete actions must use the framework `ConfirmDialog` before calling the delete endpoint. Server lifecycle actions such as kill/reboot must also require confirmation and show the standard 15-second shutdown countdown progress bar after the request succeeds.

Framework dialogs and modal forms handle Enter as the primary/confirm action and Escape as cancel/close. Do not reimplement this keyboard behavior in app-local modal code.

Prefer the framework action-menu pattern for app commands. Actions such as New task, New note, New project, archive, delete, or state transitions should live in `SidebarNode.actions` so they appear behind the three-line title-bar/item action menus. Destructive actions should be marked `destructive: true`; the framework also treats delete-labelled actions defensively, renders them red, and orders them last. Use discrete buttons mainly for form submission or inline controls that cannot reasonably live in an action menu.

Headers and menus should be allowed to shrink safely: titles and subtitles truncate, while icon buttons and action buttons keep their shape and remain visible. Context menus are framework-positioned to stay inside the visible viewport.
