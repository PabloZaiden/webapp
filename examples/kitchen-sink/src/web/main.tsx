import { Badge, Button, EmptyState, Page, Panel, TextField, WebAppRoot, appFetch, appPath, appRequest, appWebSocketUrl, renderWebApp, replaceHashRoute, useCallback, useEffect, useMemo, useRealtimeRefresh, useState, useToast, type ActionMenuItem, type SidebarNode, type WebAppRoute } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
import "./styles.css";

interface Project {
  id: string;
  name: string;
  status: "idle" | "running" | "failed";
  updatedAt: string;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await appFetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  return await response.json() as T;
}

function needsAuthentication(config: { passkeyAuth: { enabled: boolean; bootstrapRequired: boolean; ownerPasskeySetupRequired: boolean; passkeyRequired: boolean; authenticated: boolean } }): boolean {
  return config.passkeyAuth.enabled && (config.passkeyAuth.bootstrapRequired || config.passkeyAuth.ownerPasskeySetupRequired || (config.passkeyAuth.passkeyRequired && !config.passkeyAuth.authenticated));
}

function Home({ projects }: { projects: Project[] }) {
  return (
    <Page className="sink-stack">
      <Panel title="Projects" description="Protected CRUD + realtime updates.">
        {projects.length ? projects.map((project) => (
          <div className="sink-row" key={project.id}>
            <span><strong>{project.name}</strong><small>{project.updatedAt}</small></span>
            <Badge variant={project.status === "failed" ? "error" : project.status === "running" ? "info" : "default"}>{project.status}</Badge>
          </div>
        )) : <EmptyState title="No projects" />}
      </Panel>
      <NotificationExamples />
    </Page>
  );
}

function NotificationExamples() {
  const toast = useToast();
  return (
    <Panel title="Framework notifications" description="Transient feedback without an app-owned provider or queue.">
      <div className="sink-inline">
        <Button type="button" variant="primary" onClick={() => toast.success("Project saved successfully.")}>Success</Button>
        <Button type="button" variant="danger" onClick={() => toast.error("The project could not be saved.")}>Error</Button>
        <Button type="button" onClick={() => toast.warning("This action may take a moment.")}>Warning</Button>
        <Button type="button" variant="ghost" onClick={() => toast.info("This is an informational notification.")}>Info</Button>
        <Button type="button" variant="ghost" onClick={() => toast.info("Dismiss this persistent notification.", { id: "kitchen-sink-persistent", duration: 0 })}>Persistent info</Button>
        <Button type="button" variant="ghost" onClick={() => toast.dismissAll()}>Dismiss all</Button>
      </div>
    </Panel>
  );
}

function NewProjectView({ refresh }: { refresh: () => Promise<void> }) {
  const [name, setName] = useState("");
  async function createProject() {
    if (!name.trim()) return;
    await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await refresh();
  }
  return (
    <Page className="sink-stack">
      <Panel title="Create project" description="Framework coverage example.">
        <div className="sink-inline">
          <TextField label="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Button type="button" variant="primary" onClick={() => void createProject()}>Create</Button>
        </div>
      </Panel>
    </Page>
  );
}

function ProjectView({ route, projects }: { route: WebAppRoute; projects: Project[] }) {
  const project = projects.find((item) => item.id === route.projectId);
  if (!project) return <Page><EmptyState title="Project not found" /></Page>;
  return (
    <Page>
      <Panel title={project.name} description="Project detail view with common panel styling.">
        <p>Status: <Badge variant={project.status === "running" ? "info" : "default"}>{project.status}</Badge></p>
        <p className="sink-muted">Updated {project.updatedAt}</p>
      </Panel>
    </Page>
  );
}

function ActivityView({ projects, publicPing }: { projects: Project[]; publicPing: "checking" | "ok" | "failed" }) {
  const running = projects.filter((project) => project.status === "running").length;
  const failed = projects.filter((project) => project.status === "failed").length;
  const diagnosticsUrl = appPath("/public/diagnostics.json");
  const realtimeUrl = appWebSocketUrl("/api/ws");
  return (
    <Page className="sink-stack">
      <Panel title="Activity" description="Realtime and route coverage checks.">
        <div className="sink-row"><span><strong>Projects</strong><small>Total configured projects</small></span><Badge variant="default">{projects.length}</Badge></div>
        <div className="sink-row"><span><strong>Running</strong><small>Projects with active status</small></span><Badge variant="info">{running}</Badge></div>
        <div className="sink-row"><span><strong>Failed</strong><small>Projects with failure status</small></span><Badge variant={failed ? "error" : "default"}>{failed}</Badge></div>
      </Panel>
      <Panel title="Diagnostics">
        <div className="sink-row"><span><strong>Public ping</strong><small>/api/public/ping via appRequest()</small></span><Badge variant={publicPing === "ok" ? "success" : publicPing === "checking" ? "info" : "error"}>{publicPing}</Badge></div>
        <div className="sink-row"><span><strong>Webhook route</strong><small>/api/webhooks/:source/:token</small></span><Badge variant="warning">public POST</Badge></div>
        <div className="sink-row"><span><strong>Manifest</strong><small>/site.webmanifest generated by the framework</small></span><Badge variant="info">framework</Badge></div>
        <div className="sink-row"><span><strong>Diagnostics JSON</strong><small>{diagnosticsUrl}</small></span><Badge variant="info">appPath()</Badge></div>
        <div className="sink-row"><span><strong>Realtime URL</strong><small>{realtimeUrl}</small></span><Badge variant="info">appWebSocketUrl()</Badge></div>
      </Panel>
    </Page>
  );
}

function KitchenSinkApp() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [publicPing, setPublicPing] = useState<"checking" | "ok" | "failed">("checking");
  const refresh = useCallback(async () => {
    const config = await api<{ passkeyAuth: { enabled: boolean; bootstrapRequired: boolean; ownerPasskeySetupRequired: boolean; passkeyRequired: boolean; authenticated: boolean } }>("/api/config");
    if (needsAuthentication(config)) return;
    setProjects(await api<Project[]>("/api/projects"));
  }, []);
  useEffect(() => void refresh().catch(() => undefined), [refresh]);
  useEffect(() => {
    void appRequest("/api/public/ping")
      .then((response) => setPublicPing(response.ok ? "ok" : "failed"))
      .catch(() => setPublicPing("failed"));
  }, []);
  useRealtimeRefresh({ resources: ["projects"], refresh: () => refresh() });

  const updateProjectStatus = useCallback(async (project: Project, status: Project["status"]) => {
    await api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    await refresh();
  }, [refresh]);

  const getProjectActions = useCallback((project: Project): ActionMenuItem[] => [
    { id: "mark-running", label: "Mark running", disabled: project.status === "running", onAction: () => void updateProjectStatus(project, "running") },
    { id: "mark-idle", label: "Mark idle", disabled: project.status === "idle", onAction: () => void updateProjectStatus(project, "idle") },
    { id: "mark-failed", label: "Mark failed", destructive: true, disabled: project.status === "failed", onAction: () => void updateProjectStatus(project, "failed") },
  ], [updateProjectStatus]);

  const sidebarNodes = useMemo<SidebarNode[]>(() => [
    {
      type: "section",
      id: "projects",
      title: "Projects",
      children: projects.map((project) => ({
        type: "item",
        id: project.id,
        title: project.name,
        subtitle: project.updatedAt,
        route: { view: "project", projectId: project.id },
        pinnable: true,
        badge: project.status,
        badgeVariant: project.status === "failed" ? "error" : project.status === "running" ? "info" : "default",
        actions: getProjectActions(project),
        children: [
          { type: "item", id: `${project.id}:runs`, title: "Runs", badge: project.status === "running" ? "1" : "0" },
          { type: "item", id: `${project.id}:settings`, title: "Settings" },
        ],
      })),
    },
    {
      type: "section",
      id: "diagnostics",
      title: "Diagnostics",
      defaultCollapsed: true,
      children: [
        { type: "item", id: "activity", title: "Activity", subtitle: "Realtime checks", route: { view: "activity" } },
        { type: "item", id: "public-ping", title: "Public ping", subtitle: "/api/public/ping", route: { view: "activity" } },
        { type: "item", id: "webhooks", title: "Webhook route", subtitle: "/api/webhooks/:source/:token", route: { view: "activity" } },
      ],
    },
  ], [getProjectActions, projects]);

  return (
    <WebAppRoot
      appName="Kitchen Sink"
      homeRoute={{ view: "home" }}
      sidebar={{
        topActions: [
          { id: "activity", title: "Activity", icon: "↯", route: { view: "activity" } },
        ],
        getNodes: ({ search }) => {
          if (!search.trim()) return sidebarNodes;
          const q = search.toLowerCase();
          return sidebarNodes.map((section) => ({
            ...section,
            children: section.children?.filter((child) => child.title.toLowerCase().includes(q)),
          }));
        },
      }}
      routes={{
        home: <Home projects={projects} />,
        "new-project": <NewProjectView refresh={refresh} />,
        activity: <ActivityView projects={projects} publicPing={publicPing} />,
        project: (route) => <ProjectView route={route} projects={projects} />,
      }}
      header={{
        getActions: ({ route }) => {
          if (route.view !== "project") return [{ id: "new-project", label: "New project", onAction: () => { replaceHashRoute("#/new-project"); } }];
          const project = projects.find((item) => item.id === route.projectId);
          return [
            { id: "new-project", label: "New project", onAction: () => { replaceHashRoute("#/new-project"); } },
            ...(project ? getProjectActions(project) : []),
          ];
        },
      }}
      settings={{
        sections: [
          {
            id: "coverage",
            title: "Coverage",
            scope: "user",
            rows: [
              {
                id: "framework-coverage",
                title: "Framework coverage",
                description: `Projects: ${projects.length}. Public route, protected CRUD, realtime, device auth, API keys and passkeys are enabled.`,
              },
              {
                id: "admin-route",
                title: "Admin route",
                scope: "admin",
                description: "/api/admin/summary demonstrates app-owned admin-only APIs with ctx.requireAdmin().",
              },
            ],
          },
        ],
      }}
    />
  );
}

renderWebApp(<KitchenSinkApp />);
