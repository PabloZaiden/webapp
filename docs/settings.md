# Settings

Settings is framework-owned so apps stay consistent. It includes:

- Passkey logout/delete
- API key create/list/delete when enabled
- Theme preference: system/light/dark
- Log-level preference unless `{PREFIX}_LOG_LEVEL` is set
- Server kill
- Version/about

Apps can append structured custom sections:

```tsx
<WebAppRoot
  settings={{
    sections: [
      {
        id: "sync",
        title: "Sync",
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
