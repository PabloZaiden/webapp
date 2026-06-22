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
