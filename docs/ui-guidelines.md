# UI guidelines

The framework intentionally provides a consistent base UI:

- Fixed sidebar header and main header share the same height.
- Sidebar content scrolls independently; the title row, version footer and optional tab bar stay fixed.
- Sidebar width is desktop-first and collapsible; mobile uses a drawer with backdrop.
- Desktop sidebar collapse is a persisted shell preference; mobile drawer openness is transient and is reset when the responsive mode changes.
- The app title in the sidebar navigates home.
- Settings and collapse controls are framework-owned.
- Version is always visible at the bottom of the sidebar.
- Main content should prefer panels, toolbars, badges and simple forms over custom one-off layouts.
- `WebAppRoot` owns the fixed main title bar and `.wapp-main-content`; app routes should not render or style those shell elements directly.

## Transient notifications

Use `useToast()` from `@pablozaiden/webapp/web` for short-lived success,
error, warning, or informational feedback. The standard `renderWebApp` runtime
already owns the provider, queue, timers, live region, dismissal controls, and
styling, so applications must not add a parallel toast provider, queue, or
notification CSS. Use the returned ID with `dismiss` when an operation needs
to close a persistent notification, or use `dismissAll` to clear the queue.

Notifications appear only in the main header, never in the sidebar or a
floating overlay. Keep the preview to a single line with a severity icon and
colored text on desktop. On mobile, always show only the colored severity icon
and any additional-message count, keeping the full message accessible to
screen readers rather than displaying truncated text.
Clicking it opens the framework `Modal` with the full active messages.
Additional active messages are counted beside the preview, and
errors take priority over non-error messages. The default lifetime is five
seconds, with no history after expiration or dismissal. A message already
opened in the modal remains readable until the modal is closed.
Announcements remain available to assistive technology while a drawer or
modal is open, and the preview's accessible name includes the active count.
When the notification trigger has disappeared, closing its modal restores
keyboard focus to the current page title.

Use inline `ErrorState`, loading states, and field validation when the
information belongs to persistent page or form state. Use `ConfirmDialog` for
destructive confirmation rather than a toast, and avoid reporting one failure
twice without a distinct user-facing reason.

## Mobile breakpoint and viewport synchronization

The framework owns the mobile shell breakpoint. `MOBILE_BREAKPOINT_PX` and `MOBILE_MEDIA_QUERY` are exported from `@pablozaiden/webapp/web` for application JavaScript that needs to coordinate with the shell; do not add an independent `innerWidth` threshold for shell behavior. The generated document initializes the `data-wapp-mobile` marker on the root element before the client and styles load, and `WebAppRoot` keeps it synchronized with media-query changes. Custom CSS that follows the framework mobile mode should use that marker rather than repeating a numeric media query.

`WebAppRoot` follows `visualViewport` resize/scroll, window resize, orientation changes, focus boundaries, and mobile media-query changes. CSS `100dvh` is the authoritative height when the browser supports dynamic viewport units, except while an editable control is focused and the visual viewport is materially shorter because the on-screen keyboard is open. In that keyboard state, the hook temporarily overrides the shell height with the measured visual viewport so the keyboard cannot cover the app. The visual-viewport pixel value remains the normal fallback for browsers without `100dvh`. Two named, bounded retries catch the post-event layout pass and the end of keyboard, browser-chrome, or rotation transitions when no further geometry event is emitted. These retries are implementation fallbacks, not general synchronization primitives, and are cancelled with the associated animation frame and listeners when the root is unmounted.

Settings categories follow the framework mobile mode. List rows may respond to
their available width without changing shell behavior. Do not add global touch
handlers or arbitrary sleeps; use existing event-driven viewport lifecycle.

## Main content primitives

Use these first:

| Component | Use |
| --- | --- |
| `Page` | Required top-level route wrapper; standard padding, `layout="form"` for bounded forms, `layout="full"` for viewport-sized tools |
| `Toolbar` | Content toolbar with optional `identity`, `primary`, `secondary` slots; identity flexes before actions |
| `Panel` | Cards/sections; use `actions` for a top-right menu/action area |
| `ActionMenu` | Quiet overflow action menu for secondary surfaces; entity-level shell menus should usually come from `SidebarNode.actions` so the framework renders them in the sidebar context menu and fixed title bar |
| `FloatingPanel` | Anchored arbitrary popup content; use it instead of app-owned portals when the content is not a simple `ActionMenu` |
| `Button` / `IconButton` | Form submission and true inline controls; prefer action menus for entity/app commands |
| `Badge` | Generic status/count labels; use the default pill appearance or `appearance="text"` for a transparent, foreground-colored label |
| `StatusBadge` | Status labels in the shared transparent text appearance with title-cased words |
| `EntityHeader` | Main-content entity title/description/actions |
| `DataList` / `DataListRow` | Lists with title, description, metadata, badge and actions |
| `TextField`, `TextAreaField`, `SelectField`, `CheckboxField` | Associated labels, hints, errors and shared controls; raw `Input`/`Select` for composed forms |
| `FormGroup`, `FormActions` | Grouped forms and aligned action rows |
| `DangerZone` | Destructive settings or entity operations |
| `LoadingState`, `ErrorState` | Loading and failure UI |
| `CodeValue` | Values needed for an action, such as a new token or enrollment command; not default ID metadata |
| `SegmentedControl` | Small enum settings |
| `EmptyState` | Empty or missing content |
| `ConfirmDialog` | Destructive confirmation |

The default `Panel` is muted, `DataList` uses divided rows, and `Button` is a
subtle, intrinsic-width, unboxed action, including primary actions. Use
`variant="primary"` explicitly for the principal action, `variant="link"` for a textual action and `tone="danger"` for
discreet danger. Reserve solid `variant="danger"` for irreversible confirmation.
`ConfirmModal` defaults to primary, not danger; delete callers must explicitly
declare danger. Loading preserves button geometry and accessible name.
Show direct actions when they fit; use overflow for genuinely constrained
space or secondary groups, not to hide a single ordinary action.
Short fields use intrinsic or bounded widths. `TextField` and `SelectField`
support `fieldWidth="short" | "normal" | "full"`; use full width for URLs or
other long values. `FormGroup layout="inline"` groups related short fields
and actions, wrapping at available width.
Panel and entity-header actions stay right-aligned and inline when they fit,
including on mobile; action groups wrap to the right only when needed.

Design dark-first. Without a saved preference the document boot script, theme
hook and server preference default to Dark; existing Light/System choices are
preserved. Validate both themes, keyboard, zoom and touch. Ordinary controls
must not require consumer CSS to get accessible targets or matching styles.
Keep operational UI to labels, values, actions, statuses and actionable errors.
Do not display internal or operational identifiers unless needed for an action,
and never use UUID fallback names. Required warnings remain visible.

Settings extensions declare `category: { id, title }` on sections. The framework
renders category navigation and stores selection in its route (`category`),
using intentional replace-history navigation. Sections without a category stay
in General. Built-ins use the same `SettingsFieldRow` composition as extensions;
rows support `labelFor`, `feedback`, inline content, and typed actions with icon,
pending, disabled reason, optional confirmation and asynchronous callbacks.
`SettingsSectionContent` also supports accessible collapsible sections with
actions outside the disclosure trigger. Do not recreate row layouts locally.

Composed drafts call `useUnsavedChanges(dirty, resetDraft)` under `WebAppRoot`.
The framework keeps the current route/draft until the user cancels or explicitly
discards, combines multiple dirty forms into one confirmation, and protects
browser reload/close with the native unload boundary. Supply a visible Cancel
alongside Save; preserve failed drafts and disable duplicate submissions.
Navigation continues through framework route helpers, with no app-owned hash
listener or parser.
Native hash navigation is guarded at the same route-commit boundary without
adding history entries for framework navigation. The hook returns an
idempotent release callback: after a successful save or explicit cancel that
navigates immediately, call it before navigating so that form does not prompt
again while React commits its clean state. Other dirty forms remain protected.

`DataListRow` places `meta` beside the content by default. Use
`metaPlacement="inline"` for secondary dates beside the title, wrapping below
only when needed. Do not repeat a badge status in the description. Use
`metaPlacement="below"` for metadata below the description within the main
content column, or `metaPlacement="footer"` for a full-width footer below
the content, badge, and actions. A footer's width does not depend on the
badge or action widths, so it is suitable for timestamps and right-aligned
item/provider indicators. Existing side and below placements are unchanged.

`Modal`, `ConfirmModal`, and `ConfirmDialog` are framework-owned modal overlays.
They share focus entry and restoration, topmost-only Escape and backdrop
dismissal, Tab containment, body scroll locking, and inert background content.
Their header and footer remain fixed while the body scrolls internally when the
viewport is short, so actions remain reachable on small screens. Do not add a
second modal portal, focus trap, scroll lock, or arbitrary transition timer in
application code.
Footer actions are right-aligned in one row, wrapping to the right only when
needed; do not reverse or stretch them into a mobile column.

Use `Modal.restoreFocusFallbackRef` for a stable, programmatically focusable
target when the invoking control may disappear while the modal is open.
Normal focus restoration still prefers the invoking control when it exists.

`Dialog` is a static, in-flow surface by default. It does not claim
`aria-modal` semantics, trap focus, or lock body scrolling. Only pass its
explicit modal option when the caller also makes the rest of the page
unavailable; use `ConfirmDialog` or `Modal` for normal overlays.

For entity actions, prefer the framework title bar: define one `ActionMenuItem[]` builder and attach it to `SidebarNode.actions` for the route-backed node. The framework reuses those actions for both sidebar right-click and the active route title-bar menu. Use `WebAppRoot.header.getActions` only for additional actions not owned by a sidebar node.

Route views contribute title-bar actions with `useHeaderActions({ primary, overflow })`.
`primary` is a `HeaderPrimaryAction[]`: label, optional icon, disabled/loading
state and either `onAction` or a native `form` ID. The framework displays these
as subtle buttons while they fit within half the header; otherwise they appear
first in the existing menu, without duplicates. Fit responds to actual header
and action widths, not a separate mobile breakpoint. Native form actions retain
validation, submitter semantics and Enter submission from the menu.
`overflow` is an `ActionMenuItem[]`, appended to configured and sidebar actions.
Callbacks and loading state remain live without re-registering the screen.
A route normally has one primary action; the latest nested primary set wins.

```tsx
function ComposeView() {
  const [name, setName] = useState("");
  useHeaderActions({
    primary: [{ id: "save", label: "Save", disabled: !name.trim(), onAction: () => void save(name) }],
    overflow: [{ id: "clear", label: "Clear", onAction: () => setName("") }],
  });
  return <Page layout="form"><TextField label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} /></Page>;
}
```

`WebAppRoot.header.getHeaderActions` returns the same semantic shape.
Use `header.getActions` for extra overflow actions. Arbitrary header action
React nodes are not supported: the framework needs the action contract to
provide responsive overflow without extracting callbacks from rendered DOM.

Every route component rendered by `WebAppRoot.routes` should return `Page` at the top level, including loading/error/empty states. Do not render a `Panel`, `DataList`, `EmptyState` or custom div directly into `WebAppRoot`; that skips the standard content margins and recreates the visual bug where cards touch the main content edge. For a route whose child owns viewport-sized layout and scrolling, use `<Page layout="full">` rather than overriding `.wapp-page` from the application. Use `EntityHeader` only when the page needs a content-specific heading distinct from the fixed framework title bar; do not duplicate the active route title immediately below the header.

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

Use the temporary Bun.WebView harness described in `skills/webapp/SKILL.md` when
new visual captures are needed. Its default output is disposable; to
intentionally update these checked-in reference captures, run the
application-specific temporary harness with
`WEBVIEW_OUT_DIR="$PWD/artifacts/screenshots"` and review every changed image
before committing it. Browser automation and screenshot capture must stay
`Bun.WebView`-based and cross-platform; let Bun resolve the browser from
`PATH` rather than hard-coding a local executable path.

The framework does not add Bun.WebView or browser binaries to an application's
dependencies and does not ship a screenshot command. Run an external Bun 1.4+
harness against the already running application, and keep screenshots and
browser state there. The repository devcontainer provides Chromium for this
workflow. Do not add browser binaries, scripts, or configuration files to the
application repository.

Use these captures as the manual visual baseline before changing shell, sidebar, settings or dialog styles. When screenshots are captured to validate a visual change, review them against the specific goal; capturing files without checking the result is not validation.

All destructive delete actions must use the framework `ConfirmDialog` before calling the delete endpoint. Server lifecycle actions such as kill/reboot must also require confirmation and show the standard 15-second shutdown countdown progress bar after the request succeeds.

Framework dialogs and modal forms handle Enter as the primary/confirm action and Escape as cancel/close. Do not reimplement this keyboard behavior in app-local modal code.

Prefer the framework action-menu pattern for app commands. Actions such as New task, New note, New project, archive, delete, or state transitions should live in `SidebarNode.actions` so they appear behind the quiet overflow title-bar/item action menus. Destructive actions should be marked `destructive: true`; the framework also treats delete-labelled actions defensively, renders them red, and orders them last. Use discrete buttons mainly for form submission or inline controls that cannot reasonably live in an action menu.

Headers and menus should be allowed to shrink safely: titles and subtitles truncate, while icon buttons and action buttons keep their shape and remain visible. Context menus are framework-positioned to stay inside the visible viewport.
