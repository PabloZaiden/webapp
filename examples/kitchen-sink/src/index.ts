import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";

type Event = ResourceRealtimeEvent;

interface Project {
  id: string;
  name: string;
  status: "idle" | "running" | "failed";
  updatedAt: string;
}

const projects: Project[] = [
  { id: "alpha", name: "Alpha", status: "running", updatedAt: new Date().toISOString() },
  { id: "beta", name: "Beta", status: "idle", updatedAt: new Date().toISOString() },
];

const routes = defineRoutes<Event>({
  "/api/projects": {
    GET: () => jsonResponse(projects),
    async POST(req, ctx) {
      const body = await parseJson<{ name: string }>(req);
      const project = { id: crypto.randomUUID(), name: body.name, status: "idle" as const, updatedAt: new Date().toISOString() };
      projects.unshift(project);
      ctx.realtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/projects/:id": {
    async PATCH(req, ctx) {
      const project = projects.find((item) => item.id === ctx.params.id);
      if (!project) return jsonResponse({ error: "not_found" }, { status: 404 });
      Object.assign(project, await parseJson<Partial<Project>>(req), { updatedAt: new Date().toISOString() });
      ctx.realtime.publishEntityChanged("projects", project.id);
      return jsonResponse(project);
    },
  },
  "/api/public/ping": {
    auth: "public",
    sameOrigin: "never",
    GET: () => jsonResponse({ pong: true }),
  },
  "/api/webhooks/:source/:token": {
    auth: "public",
    sameOrigin: "never",
    async POST(_req, ctx) {
      projects.unshift({ id: crypto.randomUUID(), name: `Webhook ${ctx.params.source}`, status: "running", updatedAt: new Date().toISOString() });
      ctx.realtime.publishChanged("projects");
      return jsonResponse({ ok: true });
    },
  },
});

const app = createWebAppServer<Event>({
  appName: "Kitchen Sink",
  envPrefix: "KITCHEN_SINK",
  index: webIndex,
  version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
  store: sqliteWebAppStore({ dataDir: process.env["KITCHEN_SINK_DATA_DIR"] ?? "./data" }),
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  routes,
});

await app.runFromCli();
