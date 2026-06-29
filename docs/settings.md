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
