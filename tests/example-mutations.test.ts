import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { CurrentUser } from "../src/contracts";
import { createApiKey } from "../src/server/auth/api-keys";
import type { WebAppServer } from "../src/server/create-web-app-server";
import type { WebSocketData } from "../src/server/realtime/bus";
import type { UserRecord, WebAppStore } from "../src/server/auth/store";
import { createNotesTodoApp } from "../examples/notes-todo/src/app";

const kitchenDataDir = `.cache/tests/example-mutations-kitchen-${crypto.randomUUID()}`;
const notesDataDir = `.cache/tests/example-mutations-notes-${crypto.randomUUID()}`;
const { kitchen, notesTodo } = await (async () => {
  const previousKitchenDataDir = process.env["KITCHEN_SINK_DATA_DIR"];
  const previousNotesDataDir = process.env["NOTES_TODO_DATA_DIR"];
  try {
    process.env["KITCHEN_SINK_DATA_DIR"] = kitchenDataDir;
    process.env["NOTES_TODO_DATA_DIR"] = notesDataDir;
    return {
      kitchen: await import("../examples/kitchen-sink/src/index.ts"),
      notesTodo: await import("../examples/notes-todo/src/index.ts"),
    };
  } finally {
    if (previousKitchenDataDir === undefined) {
      delete process.env["KITCHEN_SINK_DATA_DIR"];
    } else {
      process.env["KITCHEN_SINK_DATA_DIR"] = previousKitchenDataDir;
    }
    if (previousNotesDataDir === undefined) {
      delete process.env["NOTES_TODO_DATA_DIR"];
    } else {
      process.env["NOTES_TODO_DATA_DIR"] = previousNotesDataDir;
    }
  }
})();

function configureApiKey(store: WebAppStore, username: string): { user: UserRecord; token: string } {
  const now = new Date().toISOString();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role: "owner",
    authVersion: 1,
    passkeyConfigured: false,
    createdAt: now,
    updatedAt: now,
  };
  store.createUser(user);
  const currentUser: CurrentUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: true,
    isAdmin: true,
  };
  return { user, token: createApiKey(store, currentUser, { name: `${username} test key` }).token };
}

async function responseJson<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

async function apiRequest<T>(
  app: WebAppServer<T>,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response | undefined> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return await app.handleRequest(new Request(`http://localhost${path}`, { ...init, headers }));
}

const unsupportedSocketMethod = (): never => {
  throw new Error("This test socket method is not implemented");
};

function captureEvents<T>(app: WebAppServer<T>, userId: string) {
  const messages: string[] = [];
  const socket = {
    data: { userId },
    send(payload) {
      if (typeof payload !== "string") {
        throw new TypeError("The test socket only accepts string messages");
      }
      messages.push(payload);
      return 0;
    },
    sendText: unsupportedSocketMethod,
    sendBinary: unsupportedSocketMethod,
    close: unsupportedSocketMethod,
    terminate: unsupportedSocketMethod,
    ping: unsupportedSocketMethod,
    pong: unsupportedSocketMethod,
    publish: unsupportedSocketMethod,
    publishText: unsupportedSocketMethod,
    publishBinary: unsupportedSocketMethod,
    subscribe: unsupportedSocketMethod,
    unsubscribe: unsupportedSocketMethod,
    isSubscribed: unsupportedSocketMethod,
    subscriptions: [],
    cork<TValue = unknown>(_callback: (socket: ServerWebSocket<TValue>) => TValue): TValue {
      return unsupportedSocketMethod();
    },
    remoteAddress: "127.0.0.1",
    readyState: 1,
    getBufferedAmount: unsupportedSocketMethod,
  } satisfies ServerWebSocket<WebSocketData>;
  app.realtime.add(socket);
  return {
    messages,
    close() {
      app.realtime.remove(socket);
    },
  };
}

const kitchenAuth = configureApiKey(kitchen.app.store, "kitchen-owner");
const notesAuth = configureApiKey(notesTodo.app.store, "notes-owner");

describe("example application mutations", () => {
  test("updates only mutable project fields and publishes the canonical project ID", async () => {
    const listed = await apiRequest(kitchen.app, kitchenAuth.token, "/api/projects");
    expect(listed?.status).toBe(200);
    const projects = await responseJson<Array<{ id: string; userId: string; name: string; status: string }>>(listed);
    expect(projects.length).toBeGreaterThan(0);
    const original = projects[0]!;
    const events = captureEvents(kitchen.app, kitchenAuth.user.id);

    try {
      const updatedResponse = await apiRequest(kitchen.app, kitchenAuth.token, `/api/projects/${original.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: "",
          status: "failed",
          id: "attacker-controlled-id",
          userId: "attacker-controlled-user",
          unexpected: "not persisted",
        }),
      });
      expect(updatedResponse?.status).toBe(200);
      const updated = await responseJson<Record<string, unknown>>(updatedResponse);

      expect(updated).toMatchObject({
        id: original.id,
        userId: kitchenAuth.user.id,
        name: "",
        status: "failed",
      });
      expect(updated).not.toHaveProperty("unexpected");
      expect(JSON.parse(events.messages[events.messages.length - 1]!).event).toMatchObject({
        type: "projects.changed",
        id: original.id,
      });
    } finally {
      events.close();
    }
  });

  test("protects note and todo identity while preserving falsy updates and section ownership", async () => {
    const sectionsResponse = await apiRequest(notesTodo.app, notesAuth.token, "/api/sections");
    expect(sectionsResponse?.status).toBe(200);
    const sections = await responseJson<Array<{ id: string }>>(sectionsResponse);
    expect(sections.length).toBeGreaterThan(0);
    const validSection = sections[0]!;

    const invalidParentResponse = await apiRequest(notesTodo.app, notesAuth.token, "/api/sections", {
      method: "POST",
      body: JSON.stringify({ title: "Invalid parent", parentId: "" }),
    });
    expect(invalidParentResponse?.status).toBe(404);

    const notesResponse = await apiRequest(notesTodo.app, notesAuth.token, "/api/notes");
    expect(notesResponse?.status).toBe(200);
    const notes = await responseJson<Array<{ id: string; userId: string }>>(notesResponse);
    expect(notes.length).toBeGreaterThan(0);
    const originalNote = notes[0]!;
    const noteEvents = captureEvents(notesTodo.app, notesAuth.user.id);

    try {
      const updatedNoteResponse = await apiRequest(notesTodo.app, notesAuth.token, `/api/notes/${originalNote.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "",
          body: "",
          sectionId: validSection.id,
          id: "attacker-controlled-id",
          userId: "attacker-controlled-user",
          unexpected: "not persisted",
        }),
      });
      expect(updatedNoteResponse?.status).toBe(200);
      const updatedNote = await responseJson<Record<string, unknown>>(updatedNoteResponse);

      expect(updatedNote).toMatchObject({
        id: originalNote.id,
        userId: notesAuth.user.id,
        title: "",
        body: "",
        sectionId: validSection.id,
      });
      expect(updatedNote).not.toHaveProperty("unexpected");
      expect(JSON.parse(noteEvents.messages[noteEvents.messages.length - 1]!).event).toMatchObject({
        type: "notes.changed",
        id: originalNote.id,
      });
    } finally {
      noteEvents.close();
    }

    const foreignSectionResponse = await apiRequest(notesTodo.app, notesAuth.token, `/api/notes/${originalNote.id}`, {
      method: "PATCH",
      body: JSON.stringify({ sectionId: "other-user:private" }),
    });
    expect(foreignSectionResponse?.status).toBe(404);

    const todosResponse = await apiRequest(notesTodo.app, notesAuth.token, "/api/todos");
    expect(todosResponse?.status).toBe(200);
    const todos = await responseJson<Array<{ id: string; userId: string }>>(todosResponse);
    expect(todos.length).toBeGreaterThan(0);
    const originalTodo = todos[0]!;
    const todoEvents = captureEvents(notesTodo.app, notesAuth.user.id);

    try {
      const updatedTodoResponse = await apiRequest(notesTodo.app, notesAuth.token, `/api/todos/${originalTodo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "",
          completed: false,
          priority: "low",
          sectionId: validSection.id,
          id: "attacker-controlled-id",
          userId: "attacker-controlled-user",
          unexpected: "not persisted",
        }),
      });
      expect(updatedTodoResponse?.status).toBe(200);
      const updatedTodo = await responseJson<Record<string, unknown>>(updatedTodoResponse);

      expect(updatedTodo).toMatchObject({
        id: originalTodo.id,
        userId: notesAuth.user.id,
        title: "",
        completed: false,
        priority: "low",
        sectionId: validSection.id,
      });
      expect(updatedTodo).not.toHaveProperty("unexpected");
      expect(JSON.parse(todoEvents.messages[todoEvents.messages.length - 1]!).event).toMatchObject({
        type: "todos.changed",
        id: originalTodo.id,
      });
    } finally {
      todoEvents.close();
    }
  });

  test("validates webhook bodies before creating todos or publishing events", async () => {
    const webhookPath = "/api/webhooks/test-source/test-token";
    const listTodos = async () => {
      const response = await apiRequest(notesTodo.app, notesAuth.token, "/api/todos");
      expect(response?.status).toBe(200);
      return await responseJson<Array<{ id: string; title: string }>>(response);
    };
    const initialTodos = await listTodos();
    const events = captureEvents(notesTodo.app, notesAuth.user.id);

    try {
      const validResponse = await apiRequest(notesTodo.app, notesAuth.token, webhookPath, {
        method: "POST",
        body: JSON.stringify({ title: "Webhook title" }),
      });
      expect(validResponse?.status).toBe(200);
      expect(await responseJson<{ ok: boolean }>(validResponse)).toEqual({ ok: true });
      let todos = await listTodos();
      expect(todos).toHaveLength(initialTodos.length + 1);
      expect(todos.some(({ title }) => title === "Webhook title")).toBe(true);
      expect(events.messages).toHaveLength(1);
      expect(JSON.parse(events.messages[0]!).event).toMatchObject({
        type: "todos.changed",
        resource: "todos",
        action: "changed",
      });

      const emptyObjectResponse = await apiRequest(notesTodo.app, notesAuth.token, webhookPath, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(emptyObjectResponse?.status).toBe(200);
      todos = await listTodos();
      expect(todos).toHaveLength(initialTodos.length + 2);
      expect(todos.some(({ title }) => title === "Webhook from test-source")).toBe(true);
      expect(events.messages).toHaveLength(2);

      const emptyBodyResponse = await apiRequest(notesTodo.app, notesAuth.token, webhookPath, { method: "POST" });
      expect(emptyBodyResponse?.status).toBe(200);
      todos = await listTodos();
      expect(todos).toHaveLength(initialTodos.length + 3);
      expect(todos.filter(({ title }) => title === "Webhook from test-source")).toHaveLength(2);
      expect(events.messages).toHaveLength(3);

      const beforeRejected = todos;
      const eventCountBeforeRejected = events.messages.length;
      const rejectedBodies = [
        { body: "{", error: "invalid_json" },
        { body: " \n\t", error: "invalid_json" },
        { body: JSON.stringify(null), error: "invalid_request_body" },
        { body: JSON.stringify({ title: 42 }), error: "invalid_request_body" },
        { body: JSON.stringify({ title: "" }), error: "invalid_request_body" },
        { body: JSON.stringify({ title: "x".repeat(201) }), error: "invalid_request_body" },
      ] as const;

      for (const rejected of rejectedBodies) {
        const response = await apiRequest(notesTodo.app, notesAuth.token, webhookPath, {
          method: "POST",
          body: rejected.body,
        });
        expect(response?.status).toBe(400);
        expect(await responseJson<{ error: string }>(response)).toMatchObject({ error: rejected.error });
        expect(await listTodos()).toHaveLength(beforeRejected.length);
        expect(events.messages).toHaveLength(eventCountBeforeRejected);
      }
    } finally {
      events.close();
    }
  });

  test("preserves the ownerless webhook acceptance response", async () => {
    const ownerless = createNotesTodoApp({
      dataDir: `.cache/tests/example-mutations-notes-ownerless-${crypto.randomUUID()}`,
    });
    const response = await ownerless.handleRequest(new Request("http://localhost/api/webhooks/test-source/test-token", {
      method: "POST",
    }));

    expect(response?.status).toBe(202);
    expect(await responseJson<{ ok: boolean; accepted: boolean }>(response)).toEqual({ ok: true, accepted: false });
  });
});
