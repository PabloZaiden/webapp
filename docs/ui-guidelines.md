# UI guidelines

The framework intentionally provides a consistent base UI:

- Fixed sidebar header and main header share the same height.
- Sidebar content scrolls independently; the title row and footer stay fixed.
- Sidebar width is desktop-first and collapsible; mobile uses a drawer with backdrop.
- The app title in the sidebar navigates home.
- Settings and collapse controls are framework-owned.
- Version is always visible at the bottom of the sidebar.
- Main content should prefer panels, toolbars, badges and simple forms over custom one-off layouts.

## Main content primitives

Use these first:

| Component | Use |
| --- | --- |
| `Toolbar` | Page title/actions inside main content |
| `Panel` | Cards/sections; use `actions` for a top-right menu/action area |
| `ActionMenu` | Three-line action menu for secondary surfaces; entity-level menus should usually be exposed through `WebAppRoot.header.getActions` so they render in the fixed title bar |
| `Button` / `IconButton` | Form submission and true inline controls; prefer action menus for entity/app commands |
| `Badge` | Status/count labels |
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

For entity actions, prefer the framework title bar: define one `ActionMenuItem[]` builder, attach it to `SidebarNode.actions` for right-click, and return the same actions from `WebAppRoot.header.getActions` for the selected route.

## Visual validation captures

Generated screenshots live in `artifacts/screenshots`:

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

Use `bun run screenshots` to regenerate these captures with Playwright. Browser automation and screenshot capture must stay Playwright-based and cross-platform; do not hard-code local Chrome or OS-specific browser paths.

Use these captures as the manual visual baseline before changing shell, sidebar, settings or dialog styles. When screenshots are captured to validate a visual change, review them against the specific goal; capturing files without checking the result is not validation.

All destructive delete actions must use the framework `ConfirmDialog` before calling the delete endpoint. Server lifecycle actions such as kill/reboot must also require confirmation and show the standard 15-second shutdown countdown progress bar after the request succeeds.

Prefer the framework action-menu pattern for app commands. Actions such as New task, New note, New project, archive, delete, or state transitions should live in `SidebarNode.actions` and/or `WebAppRoot.header.getActions` so they appear behind the three-line title-bar/item action menus. Use discrete buttons mainly for form submission or inline controls that cannot reasonably live in an action menu.
