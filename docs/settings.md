# Settings

Settings is framework-owned so apps stay consistent. It includes:

- Account summary and passkey logout/delete
- User API key create/list/delete for the current user when enabled
- Device-auth sessions for the current user when enabled
- Theme preference: system/light/dark, stored per user and cached in browser
  storage when available
- Admin user management
- Admin log-level preference unless `{PREFIX}_LOG_LEVEL` is set
- Admin server-log capture preference, disabled by default and saved by the
  configured store; captured logs remain temporary and are removed on clean
  shutdown or when capture is turned off
- Admin server kill
- Version/about

Settings groups controls into **General**, **Account & access**,
**Administration**, and **About**. Apps can add named categories through
`section.category`; sections without a category join **General**. Section and
row scope rules determine which application-defined settings are shown.

Settings remembers the last opened category in browser storage per app and,
for remote clients, per connected server. Reopening Settings without an
explicit category restores that choice, including after a page reload.
Links to a specific category take precedence and update the remembered choice.
If the saved category is no longer available, Settings opens **General**.
Browser persistence is best-effort; storage failures are logged without
blocking navigation.

The cached theme, or Dark when no preference exists, is applied immediately while the signed-in
user preference loads in the background. Browser storage is best-effort:
unavailable or corrupt storage falls back to a valid in-memory preference, and
a failed write does not undo the active theme. If the server preference
request fails, the current theme remains active and General Settings shows a
non-blocking error with a retry action; this server error is separate from
browser persistence and the rest of Settings remains usable.

Application code rendered inside `WebAppRoot` can use `useTheme()` from
`@pablozaiden/webapp/web` when JavaScript needs theme state. The hook exposes
the selected `preference` and concrete `resolvedTheme`; the latter updates
when the operating-system color scheme changes in `system` mode. Prefer CSS
dark-mode styling when no JavaScript theme value is required, and do not infer
theme state by observing framework-owned DOM classes or attributes.
`setPreference` updates the local preference; await `savePreference` to persist
it for the signed-in user. Without a current user, saving remains local and
does not call the authenticated preference API. Failed saves reject for caller
feedback and only restore their previous preference if no newer choice or
user change has superseded them. Settings owns its feedback separately from
the provider so leaving and reopening a category cannot revive stale errors.

Application code can use `useLogLevel()` from `@pablozaiden/webapp/web` to
adapt an application-owned logger to the framework's effective client setting.
The hook exposes `level`, `fromEnv`, `loading`, `error`, and `retry`. The level
and environment metadata are unavailable until `/api/config` has loaded and
validated; configuration failures remain visible through `error` instead of
falling back to a fabricated level. The framework Settings selector updates
the shared hook state after a successful save, and `fromEnv` is true when
`{PREFIX}_LOG_LEVEL` locks the value. Applications should not add a separate
configuration fetch or initializer component.

Administration also includes **Preserve logs**. It is an admin-only global
preference stored by the configured `WebAppStore`; the default SQLite store
persists it across server restarts. When no preference is saved, capture
defaults to disabled. With a custom store, persistence follows that store's
behavior. When enabled, the shared `tslog` service appends eligible entries to
a private JSON Lines file in the operating system's temporary directory. The
preference survives a restart, but captured entries do not: clean shutdown
removes the file and the next start creates a fresh one. Disabling capture
also removes the file; abrupt termination may leave it for the operating
system's temporary-file cleanup. There is no entry or size limit; retrieving
the snapshot loads all entries into memory, and the unbounded file can exhaust
the temporary filesystem. Writes are synchronous and can add latency at high
log volume; avoid logging secrets. Captured logs are never stored in SQLite.

Security lists only show useful active user credentials. Managed API keys created by
server-side applications, and their metadata, are not returned by the browser API-key
list or rendered in Settings. Expired API keys are purged before listing, and revoked
or expired device-auth refresh sessions are not shown. Revoked refresh sessions may
remain in storage when needed for token-reuse protection, but they are hidden from Settings.

Destructive actions in Settings use the framework `ConfirmDialog` before mutating. This includes deleting users, deleting API keys, deleting passkeys, revoking device-auth sessions, and killing the server.

The server kill control follows the normal Settings row layout: explanation on the left, action on the right. After confirmation and a successful response, Settings shows a 15-second shutdown countdown progress bar that visibly drains before reloading the page.

Apps can append structured custom sections:

```tsx
<WebAppRoot
  settings={{
    sections: [
      {
        id: "sync",
        title: "Sync",
        scope: "user",
        rows: [
          {
            id: "last-sync",
            title: "Last sync",
            description: lastSync,
            actions: [{ id: "sync-now", label: "Sync now", onAction: syncNow }],
          },
          {
            id: "auto-sync",
            title: "Automatic sync",
            content: <input type="checkbox" checked={autoSync} onChange={toggleAutoSync} />,
            contentPlacement: "inline",
          },
          {
            id: "disconnect",
            title: "Disconnect",
            scope: "admin",
            description: "Stops syncing this workspace.",
            danger: true,
            actions: [{ id: "disconnect", label: "Disconnect", variant: "danger", onAction: disconnect }],
          },
        ],
      },
    ],
  }}
/>
```

`render` remains available as an escape hatch for custom controls inside a section. Prefer structured `rows` for simple settings because the framework keeps spacing, typography and danger-zone styling consistent.

Row content is inline by default, with compact controls and actions aligned
right of the label. The label and controls share a vertically centered row
when space permits; otherwise the controls wrap below the label and stay
right-aligned instead of collapsing the label column. This follows the row's
available width independently of the desktop/mobile shell breakpoint.
Labels use their content width rather than reserving a fixed label column.
When the control group itself cannot fit on one line, fields and actions
wrap within the row's available width; action groups keep their order and
right alignment. Forms inside section/group panels can shrink with the panel
instead of imposing an intrinsic minimum width or overflowing it.
Put a setting's field in `content` and its buttons in `actions`, not in a stacked
form inside `content`. If they share a native form, wrap `SettingsFieldRow` in
that form so the input remains aligned with the label.
Use `Select` or `SelectField` with an appropriate field
width rather than stretching short values. Inline `Select` controls size to
their options so adjacent actions stay on the same line when they fit; use
`fieldWidth="full"` when a select should stretch. Compact select rows retain
their label and control columns on mobile, letting the label wrap rather than
moving the controls below it. Set `contentPlacement: "below"`
explicitly for editors and other wide content; this spans the full row below
the label while actions stay right-aligned. Failed confirmed actions close the
confirmation before showing the row's accessible inline error.

`scope` can be `user`, `admin` or `owner` on both sections and rows. Omitted scope behaves like `user`. Use `admin` for global app/server settings and `user` for preferences or data that belong to the signed-in user.
