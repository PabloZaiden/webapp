import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";

type NotesTodoEvent = ResourceRealtimeEvent;

interface Section {
  id: string;
  userId: string;
  title: string;
  parentId?: string;
}

interface Note {
  id: string;
  userId: string;
  sectionId: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface Todo {
  id: string;
  userId: string;
  sectionId: string;
  title: string;
  completed: boolean;
  priority: "low" | "normal" | "high";
  updatedAt: string;
}

const sections: Section[] = [];
const notes: Note[] = [];
const todos: Todo[] = [];
const store = sqliteWebAppStore({ dataDir: process.env["NOTES_TODO_DATA_DIR"] ?? "./data" });

function nowIso() {
  return new Date().toISOString();
}

function ensureSeedData(userId: string) {
  if (store.getOwnerUser()?.id !== userId) return;
  if (sections.some((section) => section.userId === userId)) return;
  const inboxId = `${userId}:inbox`;
  const workId = `${userId}:work`;
  const sprintId = `${userId}:sprint`;
  const productId = `${userId}:product`;
  const personalId = `${userId}:personal`;
  sections.push(
    { id: inboxId, userId, title: "Inbox" },
    { id: workId, userId, title: "Work" },
    { id: sprintId, userId, title: "Sprint planning", parentId: workId },
    { id: productId, userId, title: "Product ideas", parentId: workId },
    { id: personalId, userId, title: "Personal" },
  );
  notes.push(
    { id: crypto.randomUUID(), userId, sectionId: productId, title: "App shell notes", body: "Use sidebar item actions, header actions, pins, scoped settings, and user-owned routes.", updatedAt: nowIso() },
    { id: crypto.randomUUID(), userId, sectionId: sprintId, title: "Migration checklist", body: "Start with user-owned data boundaries, then move UI routes and realtime events.", updatedAt: nowIso() },
  );
  todos.push(
    { id: crypto.randomUUID(), userId, sectionId: inboxId, title: "Triage incoming ideas", completed: false, priority: "normal", updatedAt: nowIso() },
    { id: crypto.randomUUID(), userId, sectionId: sprintId, title: "Write auth security tests", completed: false, priority: "high", updatedAt: nowIso() },
    { id: crypto.randomUUID(), userId, sectionId: sprintId, title: "Compare screenshots with the visual baseline", completed: false, priority: "normal", updatedAt: nowIso() },
    { id: crypto.randomUUID(), userId, sectionId: personalId, title: "Buy coffee", completed: true, priority: "low", updatedAt: nowIso() },
  );
}

function sectionBelongsToUser(sectionId: string, userId: string): boolean {
  return sections.some((section) => section.id === sectionId && section.userId === userId);
}

const routes = defineRoutes<NotesTodoEvent>({
  "/api/sections": {
    auth: "user",
    GET: (_req, ctx) => {
      const user = ctx.requireUser();
      ensureSeedData(user.id);
      return jsonResponse(ctx.filterOwned(sections));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ title: string; parentId?: string }>(req);
      if (body.parentId && !sectionBelongsToUser(body.parentId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
      const section = { id: crypto.randomUUID(), userId: user.id, title: body.title, parentId: body.parentId };
      sections.push(section);
      ctx.userRealtime.publishEntityChanged("sections", section.id);
      return jsonResponse(section);
    },
  },
  "/api/notes": {
    auth: "user",
    GET: (_req, ctx) => {
      const user = ctx.requireUser();
      ensureSeedData(user.id);
      return jsonResponse(ctx.filterOwned(notes));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ title: string; body?: string; sectionId: string }>(req);
      if (!sectionBelongsToUser(body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
      const note = { id: crypto.randomUUID(), userId: user.id, title: body.title, body: body.body ?? "", sectionId: body.sectionId, updatedAt: nowIso() };
      notes.unshift(note);
      ctx.userRealtime.publishEntityChanged("notes", note.id);
      return jsonResponse(note);
    },
  },
  "/api/notes/:id": {
    auth: "user",
    async PATCH(req, ctx) {
      const user = ctx.requireUser();
      const note = ctx.requireOwned(notes.find((item) => item.id === ctx.params.id));
      const body = await parseJson<Partial<Note>>(req);
      if (body.sectionId && !sectionBelongsToUser(body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
      Object.assign(note, body, { userId: user.id, updatedAt: nowIso() });
      ctx.userRealtime.publishEntityChanged("notes", note.id);
      return jsonResponse(note);
    },
    DELETE(_req, ctx) {
      const note = ctx.requireOwned(notes.find((item) => item.id === ctx.params.id));
      const index = notes.findIndex((item) => item.id === note.id && item.userId === note.userId);
      if (index >= 0) notes.splice(index, 1);
      ctx.userRealtime.publishDeleted("notes", ctx.params.id);
      return jsonResponse({ success: true });
    },
  },
  "/api/todos": {
    auth: "user",
    GET: (_req, ctx) => {
      const user = ctx.requireUser();
      ensureSeedData(user.id);
      return jsonResponse(ctx.filterOwned(todos));
    },
    async POST(req, ctx) {
      const user = ctx.requireUser();
      const body = await parseJson<{ title: string; sectionId: string; priority?: Todo["priority"] }>(req);
      if (!sectionBelongsToUser(body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
      const todo = { id: crypto.randomUUID(), userId: user.id, title: body.title, sectionId: body.sectionId, priority: body.priority ?? "normal", completed: false, updatedAt: nowIso() };
      todos.unshift(todo);
      ctx.userRealtime.publishEntityChanged("todos", todo.id);
      return jsonResponse(todo);
    },
  },
  "/api/todos/:id": {
    auth: "user",
    async PATCH(req, ctx) {
      const user = ctx.requireUser();
      const todo = ctx.requireOwned(todos.find((item) => item.id === ctx.params.id));
      const body = await parseJson<Partial<Todo>>(req);
      if (body.sectionId && !sectionBelongsToUser(body.sectionId, user.id)) return jsonResponse({ error: "not_found" }, { status: 404 });
      Object.assign(todo, body, { userId: user.id, updatedAt: nowIso() });
      ctx.userRealtime.publishEntityChanged("todos", todo.id);
      return jsonResponse(todo);
    },
    DELETE(_req, ctx) {
      const todo = ctx.requireOwned(todos.find((item) => item.id === ctx.params.id));
      const index = todos.findIndex((item) => item.id === todo.id && item.userId === todo.userId);
      if (index >= 0) todos.splice(index, 1);
      ctx.userRealtime.publishDeleted("todos", ctx.params.id);
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
    async POST(req, ctx) {
      const body = await parseJson<{ title?: string }>(req).catch((): { title?: string } => ({}));
      const owner = store.getOwnerUser();
      if (!owner) return jsonResponse({ ok: true, accepted: false }, { status: 202 });
      ensureSeedData(owner.id);
      todos.unshift({ id: crypto.randomUUID(), userId: owner.id, sectionId: `${owner.id}:inbox`, title: body.title ?? `Webhook from ${ctx.params.source}`, completed: false, priority: "normal", updatedAt: nowIso() });
      ctx.realtime.publishChanged("todos", { target: { userId: owner.id } });
      return jsonResponse({ ok: true });
    },
  },
});

const publicRoutes = {
  "/manifest.webmanifest": {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
    GET: JSON.stringify({
      name: "Notes TODO",
      short_name: "Notes",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#111827",
    }),
  },
  "/public/onboarding.txt": {
    headers: { "content-type": "text/plain; charset=utf-8" },
    GET: "Use sidebar pins, title-bar action menus, and user-owned routes to build a Notes TODO app.\n",
  },
};

const app = createWebAppServer<NotesTodoEvent>({
  appName: "Notes TODO",
  envPrefix: "NOTES_TODO",
  index: webIndex,
  version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
  store,
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  publicRoutes,
  routes,
});

await app.runFromCli();
