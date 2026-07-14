# Settings

Settings is framework-owned so apps stay consistent. It includes:

- Account summary and passkey logout/delete
- API key create/list/delete for the current user when enabled
- Device-auth sessions for the current user when enabled
- Theme preference: system/light/dark, stored per user
- Admin user management
- Admin log-level preference unless `{PREFIX}_LOG_LEVEL` is set
- Admin server kill
- Version/about

The local-storage or system theme is applied immediately while the signed-in
user preference loads in the background. If that request fails, the current
theme remains active and Display Settings shows a non-blocking error with a
retry action; the rest of Settings remains usable.

Application code rendered inside `WebAppRoot` can use `useTheme()` from
`@pablozaiden/webapp/web` when JavaScript needs theme state. The hook exposes
the selected `preference` and concrete `resolvedTheme`; the latter updates
when the operating-system color scheme changes in `system` mode. Prefer CSS
dark-mode styling when no JavaScript theme value is required, and do not infer
theme state by observing framework-owned DOM classes or attributes.

Application code can use `useLogLevel()` from `@pablozaiden/webapp/web` to
adapt an application-owned logger to the framework's effective client setting.
The hook exposes `level`, `fromEnv`, `loading`, `error`, and `retry`. The level
and environment metadata are unavailable until `/api/config` has loaded and
validated; configuration failures remain visible through `error` instead of
falling back to a fabricated level. The framework Settings selector updates
the shared hook state after a successful save, and `fromEnv` is true when
`{PREFIX}_LOG_LEVEL` locks the value. Applications should not add a separate
configuration fetch or initializer component.

Security lists only show useful active credentials. Expired API keys are purged before listing, and revoked or expired device-auth refresh sessions are not shown. Revoked refresh sessions may remain in storage when needed for token-reuse protection, but they are hidden from Settings.

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

`scope` can be `user`, `admin` or `owner` on both sections and rows. Omitted scope behaves like `user`. Use `admin` for global app/server settings and `user` for preferences or data that belong to the signed-in user.
