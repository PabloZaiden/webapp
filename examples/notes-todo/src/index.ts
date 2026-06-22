import webIndex from "./index.html";
import { createWebAppServer, defineRoutes, jsonResponse, parseJson, sqliteWebAppStore, type ResourceRealtimeEvent } from "@pablozaiden/webapp/server";

type NotesTodoEvent = ResourceRealtimeEvent;

interface Section {
  id: string;
  title: string;
  parentId?: string;
}

interface Note {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface Todo {
  id: string;
  sectionId: string;
  title: string;
  completed: boolean;
  priority: "low" | "normal" | "high";
  updatedAt: string;
}

const sections: Section[] = [
  { id: "work", title: "Work" },
  { id: "sprint", title: "Sprint", parentId: "work" },
  { id: "personal", title: "Personal" },
];
const notes: Note[] = [
  { id: "architecture", sectionId: "work", title: "Architecture ideas", body: "Use the framework shell and keep app state simple.", updatedAt: new Date().toISOString() },
];
const todos: Todo[] = [
  { id: "auth-tests", sectionId: "sprint", title: "Write auth security tests", completed: false, priority: "high", updatedAt: new Date().toISOString() },
  { id: "visual-pass", sectionId: "sprint", title: "Compare screenshots with the visual baseline", completed: false, priority: "normal", updatedAt: new Date().toISOString() },
];

function nowIso() {
  return new Date().toISOString();
}

const routes = defineRoutes<NotesTodoEvent>({
  "/api/sections": {
    GET: () => jsonResponse(sections),
    async POST(req, ctx) {
      const body = await parseJson<{ title: string; parentId?: string }>(req);
      const section = { id: crypto.randomUUID(), title: body.title, parentId: body.parentId };
      sections.push(section);
      ctx.realtime.publishEntityChanged("sections", section.id);
      return jsonResponse(section);
    },
  },
  "/api/notes": {
    GET: () => jsonResponse(notes),
    async POST(req, ctx) {
      const body = await parseJson<{ title: string; body?: string; sectionId: string }>(req);
      const note = { id: crypto.randomUUID(), title: body.title, body: body.body ?? "", sectionId: body.sectionId, updatedAt: nowIso() };
      notes.unshift(note);
      ctx.realtime.publishEntityChanged("notes", note.id);
      return jsonResponse(note);
    },
  },
  "/api/notes/:id": {
    async PATCH(req, ctx) {
      const note = notes.find((item) => item.id === ctx.params.id);
      if (!note) return jsonResponse({ error: "not_found" }, { status: 404 });
      Object.assign(note, await parseJson<Partial<Note>>(req), { updatedAt: nowIso() });
      ctx.realtime.publishEntityChanged("notes", note.id);
      return jsonResponse(note);
    },
    DELETE(_req, ctx) {
      const index = notes.findIndex((item) => item.id === ctx.params.id);
      if (index >= 0) notes.splice(index, 1);
      ctx.realtime.publishDeleted("notes", ctx.params.id);
      return jsonResponse({ success: true });
    },
  },
  "/api/todos": {
    GET: () => jsonResponse(todos),
    async POST(req, ctx) {
      const body = await parseJson<{ title: string; sectionId: string; priority?: Todo["priority"] }>(req);
      const todo = { id: crypto.randomUUID(), title: body.title, sectionId: body.sectionId, priority: body.priority ?? "normal", completed: false, updatedAt: nowIso() };
      todos.unshift(todo);
      ctx.realtime.publishEntityChanged("todos", todo.id);
      return jsonResponse(todo);
    },
  },
  "/api/todos/:id": {
    async PATCH(req, ctx) {
      const todo = todos.find((item) => item.id === ctx.params.id);
      if (!todo) return jsonResponse({ error: "not_found" }, { status: 404 });
      Object.assign(todo, await parseJson<Partial<Todo>>(req), { updatedAt: nowIso() });
      ctx.realtime.publishEntityChanged("todos", todo.id);
      return jsonResponse(todo);
    },
    DELETE(_req, ctx) {
      const index = todos.findIndex((item) => item.id === ctx.params.id);
      if (index >= 0) todos.splice(index, 1);
      ctx.realtime.publishDeleted("todos", ctx.params.id);
      return jsonResponse({ success: true });
    },
  },
  "/api/webhooks/:source/:token": {
    auth: "public",
    sameOrigin: "never",
    async POST(req, ctx) {
      const body = await parseJson<{ title?: string }>(req).catch((): { title?: string } => ({}));
      todos.unshift({ id: crypto.randomUUID(), sectionId: "work", title: body.title ?? `Webhook from ${ctx.params.source}`, completed: false, priority: "normal", updatedAt: nowIso() });
      ctx.realtime.publishChanged("todos");
      return jsonResponse({ ok: true });
    },
  },
});

const app = createWebAppServer<NotesTodoEvent>({
  appName: "Notes TODO",
  envPrefix: "NOTES_TODO",
  index: webIndex,
  version: typeof WEBAPP_VERSION === "string" ? WEBAPP_VERSION : "0.0.0-development",
  store: sqliteWebAppStore({ dataDir: process.env["NOTES_TODO_DATA_DIR"] ?? "./data" }),
  auth: { passkeys: true, apiKeys: true, deviceAuth: true },
  realtime: { path: "/api/ws" },
  routes,
});

await app.runFromCli();
