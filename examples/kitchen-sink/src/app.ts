import { z } from "zod";
import { createLogger, createWebAppServer, defineRoutes, jsonResponse, parseJson, sqliteWebAppStore, type ResourceRealtimeEvent, type WebAppStore } from "@pablozaiden/webapp/server";
import { createKitchenSinkStore, type KitchenSinkStore } from "./app-store";
import favicon from "./favicon.svg";

type Event = ResourceRealtimeEvent;
const log = createLogger("kitchen-sink");

function ensureSeedProjects(store: WebAppStore, appStore: KitchenSinkStore, userId: string) {
  if (store.getOwnerUser()?.id !== userId) return;
  appStore.ensureSeedProjects(userId);
}

const projectCreateSchema = z.object({
  name: z.string(),
});

const projectUpdateSchema = z.object({
  name: z.string().optional(),
  status: z.enum(["idle", "running", "failed"]).optional(),
});

function createKitchenSinkRoutes(store: WebAppStore, appStore: KitchenSinkStore) {
  return defineRoutes<Event>({
    "/api/projects": {
      auth: "user",
      requestSchema: projectCreateSchema,
      GET: (_req, ctx) => {
        const user = ctx.requireUser();
        ensureSeedProjects(store, appStore, user.id);
        const projects = ctx.filterOwned(appStore.listProjects(user.id));
        log.info("Listed projects", { userId: user.id, count: projects.length });
        return jsonResponse(projects);
      },
      async POST(req, ctx) {
        const user = ctx.requireUser();
        const body = await parseJson(req, projectCreateSchema);
        const project = appStore.createProject({ id: crypto.randomUUID(), userId: user.id, name: body.name, status: "idle", updatedAt: new Date().toISOString() });
        log.info("Created project", { userId: user.id, projectId: project.id });
        ctx.userRealtime.publishEntityChanged("projects", project.id);
        return jsonResponse(project);
      },
    },
    "/api/projects/:id": {
      auth: "user",
      requestSchema: projectUpdateSchema,
      async PATCH(req, ctx) {
        const user = ctx.requireUser();
        const project = ctx.requireOwned(appStore.getProject(ctx.params["id"]!, user.id));
        const body = await parseJson(req, projectUpdateSchema);
        const updated = appStore.updateProject(project.id, user.id, { ...body, updatedAt: new Date().toISOString() });
        if (!updated) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.userRealtime.publishEntityChanged("projects", updated.id);
        return jsonResponse(updated);
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
        return jsonResponse({ user: user.username, users: store.listUsers().length, projects: appStore.countProjects() });
      },
    },
    "/api/webhooks/:source/:token": {
      auth: "public",
      sameOrigin: "never",
      async POST(_req, ctx) {
        const owner = store.getOwnerUser();
        if (!owner) return jsonResponse({ ok: true, accepted: false }, { status: 202 });
        ensureSeedProjects(store, appStore, owner.id);
        appStore.createProject({ id: crypto.randomUUID(), userId: owner.id, name: `Webhook ${ctx.params["source"]!}`, status: "running", updatedAt: new Date().toISOString() });
        ctx.realtime.publishChanged("projects", { target: { userId: owner.id } });
        return jsonResponse({ ok: true });
      },
    },
  });
}

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

export function createKitchenSinkApp(options: {
  dataDir?: string;
  store?: WebAppStore;
  appStore?: KitchenSinkStore;
} = {}) {
  const dataDir = options.dataDir ?? process.env["KITCHEN_SINK_DATA_DIR"] ?? "./data";
  const store = options.store ?? sqliteWebAppStore({ dataDir });
  const appStore = options.appStore ?? createKitchenSinkStore({ dataDir });
  return createWebAppServer<Event>({
    appName: "Kitchen Sink",
    envPrefix: "KITCHEN_SINK",
    web: {
      icons: {
        favicon: { src: favicon, sizes: "any", type: "image/svg+xml" },
        appleTouch: { src: favicon, sizes: "any", type: "image/svg+xml" },
        manifest: [
          { src: favicon, sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    },
    version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
    store,
    auth: { passkeys: true, apiKeys: true, deviceAuth: true },
    realtime: { path: "/api/ws" },
    publicRoutes,
    routes: createKitchenSinkRoutes(store, appStore),
  });
}
