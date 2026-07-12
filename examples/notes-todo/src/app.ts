import { z } from "zod";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, parseOptionalJson, sqliteWebAppStore, type ResourceRealtimeEvent, type WebAppStore } from "@pablozaiden/webapp/server";
import { createNotesTodoStore, type NotesTodoStore } from "./app-store";
import favicon from "./favicon.svg";

type NotesTodoEvent = ResourceRealtimeEvent;

function nowIso() {
  return new Date().toISOString();
}

function ensureSeedData(store: WebAppStore, appStore: NotesTodoStore, userId: string) {
  if (store.getOwnerUser()?.id !== userId) return;
  appStore.ensureSeedData(userId);
}

function sectionBelongsToUser(appStore: NotesTodoStore, sectionId: string, userId: string): boolean {
  return Boolean(appStore.getSection(sectionId, userId));
}

const createSectionSchema = z.object({
  title: z.string(),
  parentId: z.string().optional(),
});

const createNoteSchema = z.object({
  title: z.string(),
  body: z.string().optional(),
  sectionId: z.string(),
});

const updateNoteSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  sectionId: z.string().optional(),
});

const createTodoSchema = z.object({
  title: z.string(),
  sectionId: z.string(),
  priority: z.enum(["low", "normal", "high"]).optional(),
});

const updateTodoSchema = z.object({
  title: z.string().optional(),
  completed: z.boolean().optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  sectionId: z.string().optional(),
});

const webhookSchema = z.object({
  title: z.string().optional(),
});

function createNotesTodoRoutes(store: WebAppStore, appStore: NotesTodoStore) {
  return defineRoutes<NotesTodoEvent>({
    "/api/sections": {
      auth: "user",
      requestSchema: createSectionSchema,
      GET: (_req, ctx) => {
        const user = ctx.requireUser();
        ensureSeedData(store, appStore, user.id);
        return jsonResponse(ctx.filterOwned(appStore.listSections(user.id)));
      },
      async POST(req, ctx) {
        const user = ctx.requireUser();
        const body = await parseJson(req, createSectionSchema);
        if (body.parentId !== undefined && !sectionBelongsToUser(appStore, body.parentId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        const section = appStore.createSection({ id: crypto.randomUUID(), userId: user.id, title: body.title, parentId: body.parentId });
        ctx.userRealtime.publishEntityChanged("sections", section.id);
        return jsonResponse(section);
      },
    },
    "/api/notes": {
      auth: "user",
      requestSchema: createNoteSchema,
      GET: (_req, ctx) => {
        const user = ctx.requireUser();
        ensureSeedData(store, appStore, user.id);
        return jsonResponse(ctx.filterOwned(appStore.listNotes(user.id)));
      },
      async POST(req, ctx) {
        const user = ctx.requireUser();
        const body = await parseJson(req, createNoteSchema);
        if (!sectionBelongsToUser(appStore, body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        const note = appStore.createNote({ id: crypto.randomUUID(), userId: user.id, title: body.title, body: body.body ?? "", sectionId: body.sectionId, updatedAt: nowIso() });
        ctx.userRealtime.publishEntityChanged("notes", note.id);
        return jsonResponse(note);
      },
    },
    "/api/notes/:id": {
      auth: "user",
      requestSchema: updateNoteSchema,
      async PATCH(req, ctx) {
        const user = ctx.requireUser();
        const note = ctx.requireOwned(appStore.getNote(ctx.params.id, user.id));
        const body = await parseJson(req, updateNoteSchema);
        if (body.sectionId !== undefined && !sectionBelongsToUser(appStore, body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        const updated = appStore.updateNote(note.id, user.id, { ...body, updatedAt: nowIso() });
        if (!updated) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.userRealtime.publishEntityChanged("notes", updated.id);
        return jsonResponse(updated);
      },
      DELETE(_req, ctx) {
        const user = ctx.requireUser();
        const note = ctx.requireOwned(appStore.getNote(ctx.params.id, user.id));
        if (!appStore.deleteNote(note.id, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.userRealtime.publishDeleted("notes", note.id);
        return jsonResponse({ success: true });
      },
    },
    "/api/todos": {
      auth: "user",
      requestSchema: createTodoSchema,
      GET: (_req, ctx) => {
        const user = ctx.requireUser();
        ensureSeedData(store, appStore, user.id);
        return jsonResponse(ctx.filterOwned(appStore.listTodos(user.id)));
      },
      async POST(req, ctx) {
        const user = ctx.requireUser();
        const body = await parseJson(req, createTodoSchema);
        if (!sectionBelongsToUser(appStore, body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        const todo = appStore.createTodo({ id: crypto.randomUUID(), userId: user.id, title: body.title, sectionId: body.sectionId, priority: body.priority ?? "normal", completed: false, updatedAt: nowIso() });
        ctx.userRealtime.publishEntityChanged("todos", todo.id);
        return jsonResponse(todo);
      },
    },
    "/api/todos/:id": {
      auth: "user",
      requestSchema: updateTodoSchema,
      async PATCH(req, ctx) {
        const user = ctx.requireUser();
        const todo = ctx.requireOwned(appStore.getTodo(ctx.params.id, user.id));
        const body = await parseJson(req, updateTodoSchema);
        if (body.sectionId !== undefined && !sectionBelongsToUser(appStore, body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        const updated = appStore.updateTodo(todo.id, user.id, { ...body, updatedAt: nowIso() });
        if (!updated) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.userRealtime.publishEntityChanged("todos", updated.id);
        return jsonResponse(updated);
      },
      DELETE(_req, ctx) {
        const user = ctx.requireUser();
        const todo = ctx.requireOwned(appStore.getTodo(ctx.params.id, user.id));
        if (!appStore.deleteTodo(todo.id, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
        ctx.userRealtime.publishDeleted("todos", todo.id);
        return jsonResponse({ success: true });
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
      requestSchema: webhookSchema,
      async POST(req, ctx) {
        const body = await parseOptionalJson(req, webhookSchema);
        const owner = store.getOwnerUser();
        if (!owner) return jsonResponse({ ok: true, accepted: false }, { status: 202 });
        ensureSeedData(store, appStore, owner.id);
        const inbox = appStore.ensureInbox(owner.id);
        appStore.createTodo({ id: crypto.randomUUID(), userId: owner.id, sectionId: inbox.id, title: body?.title ?? `Webhook from ${ctx.params.source}`, completed: false, priority: "normal", updatedAt: nowIso() });
        ctx.realtime.publishChanged("todos", { target: { userId: owner.id } });
        return jsonResponse({ ok: true });
      },
    },
  });
}

const publicRoutes = {
  "/public/onboarding.txt": {
    headers: { "content-type": "text/plain; charset=utf-8" },
    GET: "Use sidebar pins, title-bar action menus, and user-owned routes to build a Notes TODO app.\n",
  },
};

export function createNotesTodoApp(options: {
  dataDir?: string;
  store?: WebAppStore;
  appStore?: NotesTodoStore;
} = {}) {
  const dataDir = options.dataDir ?? process.env["NOTES_TODO_DATA_DIR"] ?? "./data";
  const store = options.store ?? sqliteWebAppStore({ dataDir });
  const appStore = options.appStore ?? createNotesTodoStore({ dataDir });
  return createWebAppServer<NotesTodoEvent>({
    appName: "Notes TODO",
    envPrefix: "NOTES_TODO",
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
    routes: createNotesTodoRoutes(store, appStore),
  });
}
