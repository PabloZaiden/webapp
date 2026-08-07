# Sidebar and routing

`WebAppRoot` owns the app shell: fixed sidebar title row, top action buttons, search, scrollable tree, version footer, optional tab bar, main title bar and mobile drawer behavior.

```tsx
<WebAppRoot
  appName="My App"
  homeRoute={{ view: "home" }}
  sidebar={{
    topActions: [
      { id: "activity", title: "Activity", route: { view: "home" } },
      { id: "inbox", title: "Inbox", route: { view: "inbox" } },
    ],
    tabs: [
      { id: "work", title: "Work", icon: <WorkIcon /> },
      { id: "notes", title: "Notes", icon: null },
    ],
    getNodes: ({ search, activeTab }) => buildSidebarNodes({ search, activeTab }),
  }}
  routes={{
    home: <Home />,
    project: (route) => <ProjectView id={String(route.projectId)} />,
  }}
/>
```

The first two app actions are optional; settings and collapse/uncollapse are always framework-owned and always appear as the rightmost fixed actions.

Optional sidebar tabs stay fixed at the bottom of the sidebar, below the version footer, while the tree and search remain independently scrollable. The first tab is selected by default and the selected tab id is persisted in `localStorage` per app. The active id is passed to `getNodes` as `activeTab`, alongside the normalized search value. Header actions and pinned-item actions are resolved from the visible tab first and expanded to other configured tabs when the active route or a stored pin is not present there.

Tabs can be icon-only, text-only, or show an icon with a label:

```tsx
tabs: [
  { id: "work", title: "Work", icon: <WorkIcon /> },
  { id: "notes", title: "Notes", icon: null },
  { id: "admin", title: "Administration", label: "Admin", icon: <AdminIcon /> },
]
```

The `title` is used for accessibility and the tooltip. If `icon` is omitted, the framework uses the first character of `title` in uppercase as the icon; add `label` to show text below it. If `icon` is explicitly `null`, the tab is text-only. A provided icon without `label` is icon-only. Tabs use equal widths, keep a minimum touch target, and scroll horizontally when more than five are configured. Apps can provide a dynamic `tabs` array; if the persisted tab no longer exists, the first available tab is selected.

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
| `badgeAppearance` | `dot` (default) or `text`; textual badges use the shared title-case status style |
| `itemLayout` | `default` (default) or `subtitle-above-title`; the latter keeps the subtitle and textual badge on the first line and lets the title wrap below |
| `render` | Optional custom content renderer for `type: "item"` nodes; it receives the node, active/child-collapse state, navigation, and actions |
| `defaultCollapsed` | Initial collapsed state |

Search is intentionally app-defined: `getNodes({ search, activeTab })` receives trimmed search text (an empty string for a blank or whitespace-only query) and the selected tab id, and returns the tree that should be rendered. Set `sidebar.search: false` when an app has a small fixed navigation tree and should not show the sidebar search box.

### Custom item rendering

For an application-owned layout on an item node, provide `render`. The callback
returns the content inside the item; webapp always owns the interactive button,
its default class, navigation, active-route state, accessibility, and
context-menu behavior. Custom content should not return another button. If the
callback returns `null` or `undefined`, webapp uses the standard content:

```tsx
{
  type: "item",
  id: "task:123",
  title: "Improve the task list",
  route: { view: "task", taskId: "123" },
  actions: taskActions,
  render: ({ node }) => (
    <span>
      <strong>{node.title}</strong>
      <small>Custom task presentation</small>
    </span>
  ),
}
```

The render context names the child expansion state `childrenCollapsed` to
distinguish it from the framework sidebar's own collapsed state.

Custom renderers are application-owned and are not serialized into persisted
pins. When the source node is available, pinned entries reuse its current
renderer; if it is no longer available, the framework falls back to the
serializable standard presentation.

## Programmatic sidebar controls

`WebAppRoot` exposes a typed controller ref for application shell integrations that
need to control framework-owned sidebar behavior:

```tsx
import { useRef } from "react";
import { WebAppRoot, type WebAppRootController } from "@pablozaiden/webapp/web";

function AppShell() {
  const webAppRef = useRef<WebAppRootController>(null);

  const focusSidebarSearch = () => {
    webAppRef.current?.sidebar.focusSearch();
  };

  const selectTabForRoute = (route: { view: string }) => {
    const tab = route.view === "workspace" ? "workspaces" : "active";
    webAppRef.current?.sidebar.selectTab(tab);
  };

  return (
    <WebAppRoot
      ref={webAppRef}
      appName="My App"
      homeRoute={{ view: "home" }}
      sidebar={{ tabs, getNodes }}
      routes={routes}
      onRouteChange={selectTabForRoute}
    />
  );
}
```

`sidebar.open()` makes the sidebar visible: it opens the mobile drawer and
uncollapses the desktop sidebar. `sidebar.focusSearch()` does the same as needed
and focuses the search input after the visibility state is committed. It is a
no-op when `sidebar.search` is `false`. `sidebar.selectTab(id)` accepts only ids
from the configured `sidebar.tabs`; invalid ids are ignored. Route-to-tab
matching remains application-owned, while webapp keeps the selected tab
reactive and persists it.

Do not query `#wapp-sidebar`, select buttons by accessibility labels, write
`webapp.<app>.sidebar.tab`, or change the `WebAppRoot` key to synchronize a
route. The controller preserves the mounted route view and keeps those
implementation details inside webapp.

On mobile widths, the drawer can be opened with a horizontal swipe starting within the first 24px of the viewport, in addition to the header button. The gesture must move at least 64px to the right, stay within 48px of vertical displacement, and remain more horizontal than vertical.

Use `actions` when an entity needs commands in the sidebar. `WebAppRoot` finds the active route-backed sidebar node and automatically renders its `ActionMenuItem[]` in the title-bar overflow menu, so the sidebar right-click menu and header menu stay consistent from one source of truth. Use `header.getActions` only for extra route-level actions that are not represented by the active sidebar node.

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

For activity-style items with a context above the title, use the standard
`itemLayout` presentation field:

```tsx
{
  type: "item",
  id: "task:123",
  title: "Improve the task list",
  subtitle: "Frontend",
  badge: "running",
  badgeVariant: "running",
  badgeAppearance: "text",
  itemLayout: "subtitle-above-title",
  route: { view: "task", taskId: "123" },
}
```

Disable pinning with `sidebar.pinning: false`; customize storage/title with `sidebar.pinning.storageKey` and `sidebar.pinning.sectionTitle`.
