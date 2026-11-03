import { z } from "zod";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, parseOptionalJson, readRuntimeConfig, resolveAppDataDir, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";
import { createNotesTodoStore, type NotesTodoStore } from "./app-store";
import { createNotesAuth } from "./app-auth";
import favicon from "./favicon.svg";

export const notesTodoVersion = typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development";
const workspace = "example";
const title = z.string().trim().min(1).max(200);
const sectionInput = z.object({ title, parentId: z.string().optional() });
const noteInput = z.object({ title, body: z.string().max(100_000).optional(), sectionId: z.string() });
const noteUpdate = noteInput.partial();
const todoInput = z.object({ title, sectionId: z.string(), priority: z.enum(["low", "normal", "high"]).optional() });
const todoUpdate = todoInput.partial().extend({ completed: z.boolean().optional() });
const webhookInput = z.object({ title: title.optional() });
const missing = () => jsonResponse({ error: "not_found" }, { status: 404 });

export function createNotesTodoRuntime(options: { dataDir?: string; appStore?: NotesTodoStore } = {}) {
  const dataDir = options.dataDir ?? resolveAppDataDir({ envPrefix: "NOTES_TODO" });
  const config = readRuntimeConfig({
    appName: "Notes TODO", envPrefix: "NOTES_TODO",
    environment: { ...process.env, NOTES_TODO_DATA_DIR: dataDir },
  });
  const appStore = options.appStore ?? createNotesTodoStore({ dataDir });
  const auth = createNotesAuth(dataDir, config);
  const access = auth ? "required" : "public";
  appStore.ensureSeedData(workspace);
  const routes = defineRoutes<ResourceRealtimeEvent, { id: string; version: number }>({
    "/api/sections": {
      auth: access,
      GET: () => jsonResponse(appStore.listSections(workspace)),
      async POST(req, ctx) {
        const body = await parseJson(req, sectionInput);
        if (body.parentId !== undefined && !appStore.getSection(body.parentId, workspace)) return missing();
        const section = appStore.createSection({ id: crypto.randomUUID(), userId: workspace, title: body.title, parentId: body.parentId });
        ctx.realtime.publishEntityChanged("sections", section.id);
        return jsonResponse(section);
      },
    },
    "/api/notes": {
      auth: access,
      GET: () => jsonResponse(appStore.listNotes(workspace)),
      async POST(req, ctx) {
        const body = await parseJson(req, noteInput);
        if (!appStore.getSection(body.sectionId, workspace)) return missing();
        const note = appStore.createNote({
          id: crypto.randomUUID(), userId: workspace, title: body.title, body: body.body ?? "",
          sectionId: body.sectionId, updatedAt: new Date().toISOString(),
        });
        ctx.realtime.publishEntityChanged("notes", note.id);
        return jsonResponse(note);
      },
    },
    "/api/notes/:id": {
      auth: access,
      async PATCH(req, ctx) {
        const note = appStore.getNote(ctx.params["id"]!, workspace);
        if (!note) return missing();
        const body = await parseJson(req, noteUpdate);
        if (body.sectionId !== undefined && !appStore.getSection(body.sectionId, workspace)) return missing();
        const updated = appStore.updateNote(note.id, workspace, {
          title: body.title, body: body.body, sectionId: body.sectionId, updatedAt: new Date().toISOString(),
        });
        if (!updated) return missing();
        ctx.realtime.publishEntityChanged("notes", updated.id);
        return jsonResponse(updated);
      },
      DELETE(_req, ctx) {
        if (!appStore.deleteNote(ctx.params["id"]!, workspace)) return missing();
        ctx.realtime.publishDeleted("notes", ctx.params["id"]!);
        return jsonResponse({ success: true });
      },
    },
    "/api/todos": {
      auth: access,
      GET: () => jsonResponse(appStore.listTodos(workspace)),
      async POST(req, ctx) {
        const body = await parseJson(req, todoInput);
        if (!appStore.getSection(body.sectionId, workspace)) return missing();
        const todo = appStore.createTodo({
          id: crypto.randomUUID(), userId: workspace, title: body.title, sectionId: body.sectionId,
          priority: body.priority ?? "normal", completed: false, updatedAt: new Date().toISOString(),
        });
        ctx.realtime.publishEntityChanged("todos", todo.id);
        return jsonResponse(todo);
      },
    },
    "/api/todos/:id": {
      auth: access,
      async PATCH(req, ctx) {
        const todo = appStore.getTodo(ctx.params["id"]!, workspace);
        if (!todo) return missing();
        const body = await parseJson(req, todoUpdate);
        if (body.sectionId !== undefined && !appStore.getSection(body.sectionId, workspace)) return missing();
        const updated = appStore.updateTodo(todo.id, workspace, {
          title: body.title, sectionId: body.sectionId, priority: body.priority, completed: body.completed, updatedAt: new Date().toISOString(),
        });
        if (!updated) return missing();
        ctx.realtime.publishEntityChanged("todos", updated.id);
        return jsonResponse(updated);
      },
      DELETE(_req, ctx) {
        if (!appStore.deleteTodo(ctx.params["id"]!, workspace)) return missing();
        ctx.realtime.publishDeleted("todos", ctx.params["id"]!);
        return jsonResponse({ success: true });
      },
    },
    "/api/example/auth/status": {
      auth: "public", sameOrigin: "never", GET: () => jsonResponse({ enabled: false, authenticated: true }),
    },
    "/api/public/ping": { auth: "public", sameOrigin: "never", GET: () => jsonResponse({ pong: true }) },
    "/api/webhooks/:source/:token": {
      auth: "public", sameOrigin: "never",
      async POST(req, ctx) {
        const token = process.env["NOTES_TODO_WEBHOOK_TOKEN"];
        if (!token || ctx.params["token"] !== token) return missing();
        const body = await parseOptionalJson(req, webhookInput);
        const inbox = appStore.ensureInbox(workspace);
        appStore.createTodo({
          id: crypto.randomUUID(), userId: workspace, sectionId: inbox.id,
          title: body?.title ?? `Webhook from ${ctx.params["source"]!}`, completed: false, priority: "normal", updatedAt: new Date().toISOString(),
        });
        ctx.realtime.publishChanged("todos");
        return jsonResponse({ ok: true });
      },
    },
  });
  const app = createWebAppServer<ResourceRealtimeEvent, { id: string; version: number }>({
    appName: "Notes TODO", envPrefix: "NOTES_TODO", runtimeConfig: config,
    web: { entry: new URL("./web/main.tsx", import.meta.url), icons: { favicon } },
    version: notesTodoVersion, routes,
    request: auth?.request,
    identity: auth ? { authenticate: auth.authenticate } : undefined,
    realtime: auth ? { authenticate: auth.realtime } : { access: "public" },
    lifecycle: { beforeStart: auth?.enroll, afterStop: () => { auth?.close(); appStore.close(); } },
  });
  return { app, routes };
}
export function createNotesTodoApp(options?: { dataDir?: string }) { return createNotesTodoRuntime(options).app; }
