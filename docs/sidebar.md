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
| `actions` | Entity action menu items shown on sidebar right-click and automatically in the active route title-bar menu |
| `pinnable` | Enables framework Pin/Unpin actions |
| `pinId` | Stable pin identity when it should differ from `id` |
| `badge` | Status/count value; sidebar items render it as a compact status dot with accessible label/tooltip |
| `defaultCollapsed` | Initial collapsed state |

Search is intentionally app-defined: `getNodes({ search })` receives raw search text and returns the tree that should be rendered. Set `sidebar.search: false` when an app has a small fixed navigation tree and should not show the sidebar search box.

On mobile widths, the drawer can be opened with a horizontal swipe starting within the left edge of the viewport, in addition to the header button. The gesture must move at least 64px to the right without moving more than 48px vertically.

Use `actions` when an entity needs commands in the sidebar. `WebAppRoot` finds the active route-backed sidebar node and automatically renders its `ActionMenuItem[]` in the title-bar three-line menu, so the sidebar right-click menu and header menu stay consistent from one source of truth. Use `header.getActions` only for extra route-level actions that are not represented by the active sidebar node.

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
