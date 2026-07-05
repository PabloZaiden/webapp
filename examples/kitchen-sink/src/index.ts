import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";

type Event = ResourceRealtimeEvent;

interface Project {
  id: string;
  userId: string;
  name: string;
  status: "idle" | "running" | "failed";
  updatedAt: string;
}

const projects: Project[] = [];
const store = sqliteWebAppStore({ dataDir: process.env["KITCHEN_SINK_DATA_DIR"] ?? "./data" });

function ensureSeedProjects(userId: string) {
  if (store.getOwnerUser()?.id !== userId) return;
  if (projects.some((project) => project.userId === userId)) return;
  projects.push(
    { id: crypto.randomUUID(), userId, name: "Alpha", status: "running", updatedAt: new Date().toISOString() },
    { id: crypto.randomUUID(), userId, name: "Beta", status: "idle", updatedAt: new Date().toISOString() },
  );
}

const routes = defineRoutes<Event>({
  "/api/projects": {
    auth: "user",
    GET: (_req, ctx) => {
      const user = ctx.requireUser();
      ensureSeedProjects(user.id);
      return jsonResponse(ctx.filterOwned(projects));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ name: string }>(req);
      const project = { id: crypto.randomUUID(), userId: user.id, name: body.name, status: "idle" as const, updatedAt: new Date().toISOString() };
      projects.unshift(project);
      ctx.userRealtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/projects/:id": {
    auth: "user",
    async PATCH(req, ctx) {
      const project = ctx.requireOwned(projects.find((item) => item.id === ctx.params.id));
      Object.assign(project, await parseJson<Partial<Project>>(req), { updatedAt: new Date().toISOString() });
      ctx.userRealtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/public/ping": {
    auth: "public",
    sameOrigin: "never",
    GET: () => jsonResponse({ pong: true }),
  },
  "/api/admin/summary": {
    auth: "admin",
    GET: (_req, ctx) => {
      const user = ctx.requireUser();
      return jsonResponse({ user: user.username, users: store.listUsers().length, projects: projects.length });
    },
  },
  "/api/webhooks/:source/:token": {
    auth: "public",
    sameOrigin: "never",
    async POST(_req, ctx) {
      const owner = store.getOwnerUser();
      if (!owner) return jsonResponse({ ok: true, accepted: false }, { status: 202 });
      ensureSeedProjects(owner.id);
      projects.unshift({ id: crypto.randomUUID(), userId: owner.id, name: `Webhook ${ctx.params.source}`, status: "running", updatedAt: new Date().toISOString() });
      ctx.realtime.publishChanged("projects", { target: { userId: owner.id } });
      return jsonResponse({ ok: true });
    },
  },
});

const publicRoutes = {
  "/public/diagnostics.json": {
    headers: { "content-type": "application/json; charset=utf-8" },
    GET: () => JSON.stringify({
      app: "kitchen-sink",
      publicRoute: true,
      version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
    }),
  },
  "/robots.txt": {
    headers: { "content-type": "text/plain; charset=utf-8" },
    GET: "User-agent: *\nDisallow:\n",
  },
};

const app = createWebAppServer<Event>({
  appName: "Kitchen Sink",
  envPrefix: "KITCHEN_SINK",
  index: webIndex,
  version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
  store,
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  publicRoutes,
  routes,
});

await app.runFromCli();
