# Sidebar and routing

`WebAppRoot` owns the app shell: fixed sidebar title row, top action buttons, search, scrollable tree, version footer, main title bar and mobile drawer behavior.

```tsx
<WebAppRoot
  appName="My App"
  homeRoute={{ view: "home" }}
  sidebar={{
    topActions: [
      { id: "activity", title: "Activity", route: { view: "home" } },
      { id: "inbox", title: "Inbox", route: { view: "inbox" } },
    ],
    getNodes: ({ search }) => buildSidebarNodes(search),
  }}
  routes={{
    home: <Home />,
    project: (route) => <ProjectView id={String(route.projectId)} />,
  }}
/>
```

The first two app actions are optional; settings and collapse/uncollapse are always framework-owned and always appear as the rightmost fixed actions.

Sidebar nodes support:

| Field | Purpose |
| --- | --- |
| `type` | `section` or `item` |
| `route` | Hash route object used by `WebAppRoot` |
| `children` | Collapsible nesting |
| `action` | Single inline per-section/item action; use sparingly and prefer `actions` menus when possible |
| `actions` | Context menu items shown on sidebar right-click |
| `pinnable` | Enables framework Pin/Unpin actions |
| `pinId` | Stable pin identity when it should differ from `id` |
| `badge` | Status/count label |
| `defaultCollapsed` | Initial collapsed state |

Search is intentionally app-defined: `getNodes({ search })` receives raw search text and returns the tree that should be rendered. Set `sidebar.search: false` when an app has a small fixed navigation tree and should not show the sidebar search box.

Use `actions` when an entity needs commands in the sidebar. The same `ActionMenuItem[]` should also be returned from `header.getActions` for that entity route so right-click actions and the title-bar three-line menu stay consistent:

```tsx
const actions = projectActions(project);

return {
  type: "item",
  id: project.id,
  title: project.name,
  route: { view: "project", projectId: project.id },
  actions,
};

<WebAppRoot
  sidebar={{
    pinning: { sectionTitle: "Pinned" },
    getNodes,
  }}
  header={{
    getActions: ({ route }) => route.view === "project" ? projectActionsForRoute(route) : [],
  }}
/>
```

## Native pinning

Pinning is framework-owned and persisted in browser `localStorage`. Mark route-backed items as `pinnable`; `WebAppRoot` injects `Pin to sidebar` / `Unpin from sidebar` into both the sidebar context menu and the title-bar action menu for the active route. Pinned entries reuse the original sidebar node actions, so right-clicking a pinned item shows the same contextual menu as the source item.

```tsx
{
  type: "item",
  id: project.id,
  title: project.name,
  route: { view: "project", projectId: project.id },
  pinnable: true,
  actions: projectActions(project),
}
```

Disable pinning with `sidebar.pinning: false`; customize storage/title with `sidebar.pinning.storageKey` and `sidebar.pinning.sectionTitle`.
