import { z } from "zod";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, readRuntimeConfig, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";
import { createKitchenSinkStore, type KitchenSinkStore } from "./app-store";
import favicon from "./favicon.svg";

export const kitchenSinkVersion = typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development";
const createProject = z.object({ name: z.string().trim().min(1).max(200) });
const updateProject = z.object({ name: z.string().trim().min(1).max(200).optional(), status: z.enum(["idle", "running", "failed"]).optional() });

export function createKitchenSinkRuntime(options: { appStore?: KitchenSinkStore } = {}) {
  const appStore = options.appStore ?? createKitchenSinkStore();
  const routes = defineRoutes<ResourceRealtimeEvent>({
    "/api/projects": {
      auth: "public",
      description: "Shared, in-memory demo projects",
      GET: () => jsonResponse(appStore.listProjects()),
      async POST(req, ctx) {
        const body = await parseJson(req, createProject);
        const project = appStore.createProject({ id: crypto.randomUUID(), name: body.name, status: "idle", updatedAt: new Date().toISOString() });
        ctx.realtime.publishEntityChanged("projects", project.id);
        return jsonResponse(project);
      },
    },
    "/api/projects/:id": {
      auth: "public",
      async PATCH(req, ctx) {
        const body = await parseJson(req, updateProject);
        const project = appStore.updateProject(ctx.params["id"]!, {
          name: body.name, status: body.status, updatedAt: new Date().toISOString(),
        });
        if (!project) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.realtime.publishEntityChanged("projects", project.id);
        return jsonResponse(project);
      },
    },
    "/api/public/ping": { auth: "public", sameOrigin: "never", GET: () => jsonResponse({ pong: true }) },
  });
  const app = createWebAppServer<ResourceRealtimeEvent>({
    appName: "Kitchen Sink", envPrefix: "KITCHEN_SINK",
    runtimeConfig: readRuntimeConfig({ appName: "Kitchen Sink", envPrefix: "KITCHEN_SINK" }),
    web: { entry: new URL("./web/main.tsx", import.meta.url), icons: { favicon } },
    version: kitchenSinkVersion,
    realtime: { access: "public" },
    publicRoutes: {
      "/public/diagnostics.json": () => jsonResponse({ app: "kitchen-sink", persistence: "memory", authentication: "public" }),
      "/robots.txt": "User-agent: *\nDisallow:\n",
    },
    routes,
  });
  return { app, routes };
}
export function createKitchenSinkApp() { return createKitchenSinkRuntime().app; }
