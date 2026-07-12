import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { createKitchenSinkApp } from "../examples/kitchen-sink/src/app";
import { createKitchenSinkStore, type KitchenSinkStore } from "../examples/kitchen-sink/src/app-store";
import { createNotesTodoApp } from "../examples/notes-todo/src/app";
import { createNotesTodoStore, type NotesTodoStore } from "../examples/notes-todo/src/app-store";
import type { CurrentUser } from "../src/contracts";
import { createApiKey } from "../src/server/auth/api-keys";
import { sqliteWebAppStore } from "../src/server/auth/sqlite-store";
import type { UserRecord, WebAppStore } from "../src/server/auth/store";
import type { WebAppServer } from "../src/server/create-web-app-server";

type ExampleName = "notes-todo" | "kitchen-sink";
type ServerProcess = ReturnType<typeof Bun.spawn>;

const testRoot = resolve(".cache/tests");

function createIdentity(store: WebAppStore, username: string, role: "owner" | "user"): { user: UserRecord; token: string } {
  const now = new Date().toISOString();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role,
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
    isOwner: user.role === "owner",
    isAdmin: user.role === "owner",
  };
  return {
    user,
    token: createApiKey(store, currentUser, { name: `${username} persistence test key` }).token,
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  server.stop();
  if (port === undefined) {
    throw new Error("Test server did not expose an allocated port");
  }
  return port;
}

function exampleConfig(name: ExampleName): { prefix: "NOTES_TODO" | "KITCHEN_SINK"; directory: string } {
  return name === "notes-todo"
    ? { prefix: "NOTES_TODO", directory: "examples/notes-todo" }
    : { prefix: "KITCHEN_SINK", directory: "examples/kitchen-sink" };
}

async function waitForHealth(baseUrl: string, child: ServerProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Example process exited before becoming healthy: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Example process at ${baseUrl} did not become healthy`);
}

async function startExample(name: ExampleName, dataDir: string): Promise<{ child: ServerProcess; baseUrl: string }> {
  const port = await freePort();
  const { prefix, directory } = exampleConfig(name);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["bun", "src/index.ts", "serve"], {
    cwd: directory,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      [`${prefix}_HOST`]: "127.0.0.1",
      [`${prefix}_PORT`]: String(port),
      [`${prefix}_DATA_DIR`]: dataDir,
    },
  });
  await waitForHealth(baseUrl, child);
  return { child, baseUrl };
}

async function stopExample(child: ServerProcess): Promise<void> {
  if (child.exitCode === null) {
    child.kill();
  }
  await child.exited;
}

async function apiRequest(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.method && init.method !== "GET") {
    headers.set("origin", baseUrl);
  }
  return await fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function expectStatus(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
}

function captureRealtime<T>(app: WebAppServer<T>, userId: string): { messages: string[]; close: () => void } {
  const messages: string[] = [];
  const socket = {
    data: { userId },
    send(payload: string) {
      messages.push(payload);
      return 0;
    },
  };
  app.realtime.add(socket as never);
  return {
    messages,
    close() {
      app.realtime.remove(socket as never);
    },
  };
}

describe("example application persistence", () => {
  test("persists Notes TODO records and ownership boundaries across a process restart", async () => {
    const dataDir = resolve(testRoot, `example-persistence-notes-${crypto.randomUUID()}`);
    rmSync(dataDir, { recursive: true, force: true });
    const authStore = sqliteWebAppStore({ dataDir });
    authStore.initialize();
    const owner = createIdentity(authStore, "notes-persistence-owner", "owner");
    const otherUser = createIdentity(authStore, "notes-persistence-user", "user");
    let firstProcess: ServerProcess | undefined;
    let secondProcess: ServerProcess | undefined;

    try {
      const first = await startExample("notes-todo", dataDir);
      firstProcess = first.child;
      const sectionsResponse = await apiRequest(first.baseUrl, owner.token, "/api/sections");
      expectStatus(sectionsResponse, 200);
      const initialSections = await responseJson<Array<{ id: string; userId: string }>>(sectionsResponse);
      expect(initialSections.length).toBe(5);

      const notesResponse = await apiRequest(first.baseUrl, owner.token, "/api/notes");
      expectStatus(notesResponse, 200);
      const initialNotes = await responseJson<Array<{ id: string }>>(notesResponse);
      const todosResponse = await apiRequest(first.baseUrl, owner.token, "/api/todos");
      expectStatus(todosResponse, 200);
      const initialTodos = await responseJson<Array<{ id: string }>>(todosResponse);
      const inbox = initialSections.find((section) => section.id === `${owner.user.id}:inbox`);
      expect(inbox).toBeDefined();

      const sectionCreateResponse = await apiRequest(first.baseUrl, otherUser.token, "/api/sections", {
        method: "POST",
        body: JSON.stringify({ title: "Private list" }),
      });
      expectStatus(sectionCreateResponse, 200);
      const otherSection = await responseJson<{ id: string }>(sectionCreateResponse);
      const otherNoteResponse = await apiRequest(first.baseUrl, otherUser.token, "/api/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Private note", body: "Only the second user can read this.", sectionId: otherSection.id }),
      });
      expectStatus(otherNoteResponse, 200);
      const otherNote = await responseJson<{ id: string }>(otherNoteResponse);
      const otherTodoResponse = await apiRequest(first.baseUrl, otherUser.token, "/api/todos", {
        method: "POST",
        body: JSON.stringify({ title: "Private todo", sectionId: otherSection.id }),
      });
      expectStatus(otherTodoResponse, 200);
      const otherTodo = await responseJson<{ id: string }>(otherTodoResponse);

      const ownerNoteResponse = await apiRequest(first.baseUrl, owner.token, "/api/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Persisted note", body: "Survives restart.", sectionId: inbox!.id }),
      });
      expectStatus(ownerNoteResponse, 200);
      const ownerNote = await responseJson<{ id: string }>(ownerNoteResponse);
      const ownerTodoResponse = await apiRequest(first.baseUrl, owner.token, "/api/todos", {
        method: "POST",
        body: JSON.stringify({ title: "Persisted todo", sectionId: inbox!.id, priority: "high" }),
      });
      expectStatus(ownerTodoResponse, 200);
      const ownerTodo = await responseJson<{ id: string }>(ownerTodoResponse);

      const foreignNotePatch = await apiRequest(first.baseUrl, otherUser.token, `/api/notes/${ownerNote.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Should be rejected" }),
      });
      await expectStatus(foreignNotePatch, 404);
      const foreignTodoPatch = await apiRequest(first.baseUrl, otherUser.token, `/api/todos/${ownerTodo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: true }),
      });
      await expectStatus(foreignTodoPatch, 404);
      const foreignSectionNote = await apiRequest(first.baseUrl, owner.token, "/api/notes", {
        method: "POST",
        body: JSON.stringify({ title: "Wrong section", sectionId: otherSection.id }),
      });
      await expectStatus(foreignSectionNote, 404);

      const webhookResponse = await fetch(`${first.baseUrl}/api/webhooks/test-source/test-token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Persisted webhook todo" }),
      });
      await expectStatus(webhookResponse, 200);

      const ownerTodosBeforeRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(first.baseUrl, owner.token, "/api/todos"),
      );
      await stopExample(firstProcess);
      firstProcess = undefined;

      const second = await startExample("notes-todo", dataDir);
      secondProcess = second.child;
      const sectionsAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, owner.token, "/api/sections"),
      );
      const notesAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, owner.token, "/api/notes"),
      );
      const todosAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, owner.token, "/api/todos"),
      );
      expect(sectionsAfterRestart.map(({ id }) => id).sort()).toEqual(initialSections.map(({ id }) => id).sort());
      expect(notesAfterRestart.map(({ id }) => id).sort()).toEqual(
        [...initialNotes.map(({ id }) => id), ownerNote.id].sort(),
      );
      expect(todosAfterRestart.map(({ id }) => id).sort()).toEqual(
        [...initialTodos.map(({ id }) => id), ownerTodo.id, ...ownerTodosBeforeRestart
          .filter(({ id }) => !initialTodos.some((initial) => initial.id === id) && id !== ownerTodo.id)
          .map(({ id }) => id)].sort(),
      );
      expect(notesAfterRestart.some(({ id }) => id === ownerNote.id)).toBe(true);
      expect(todosAfterRestart.some(({ id }) => id === ownerTodo.id)).toBe(true);
      expect(notesAfterRestart.some(({ id }) => id === otherNote.id)).toBe(false);
      expect(todosAfterRestart.some(({ id }) => id === otherTodo.id)).toBe(false);

      const otherNotesAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, otherUser.token, "/api/notes"),
      );
      const otherTodosAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, otherUser.token, "/api/todos"),
      );
      expect(otherNotesAfterRestart.map(({ id }) => id)).toContain(otherNote.id);
      expect(otherNotesAfterRestart.map(({ id }) => id)).not.toContain(ownerNote.id);
      expect(otherTodosAfterRestart.map(({ id }) => id)).toContain(otherTodo.id);
      expect(otherTodosAfterRestart.map(({ id }) => id)).not.toContain(ownerTodo.id);
      await expectStatus(
        await apiRequest(second.baseUrl, otherUser.token, `/api/notes/${ownerNote.id}`, {
          method: "DELETE",
        }),
        404,
      );
    } finally {
      if (firstProcess) await stopExample(firstProcess);
      if (secondProcess) await stopExample(secondProcess);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("persists Kitchen Sink projects and ownership boundaries across a process restart", async () => {
    const dataDir = resolve(testRoot, `example-persistence-kitchen-${crypto.randomUUID()}`);
    rmSync(dataDir, { recursive: true, force: true });
    const authStore = sqliteWebAppStore({ dataDir });
    authStore.initialize();
    const owner = createIdentity(authStore, "kitchen-persistence-owner", "owner");
    const otherUser = createIdentity(authStore, "kitchen-persistence-user", "user");
    let firstProcess: ServerProcess | undefined;
    let secondProcess: ServerProcess | undefined;

    try {
      const first = await startExample("kitchen-sink", dataDir);
      firstProcess = first.child;
      const initialResponse = await apiRequest(first.baseUrl, owner.token, "/api/projects");
      expectStatus(initialResponse, 200);
      const initialProjects = await responseJson<Array<{ id: string }>>(initialResponse);
      expect(initialProjects.length).toBe(2);

      const ownerProjectResponse = await apiRequest(first.baseUrl, owner.token, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Persisted project" }),
      });
      expectStatus(ownerProjectResponse, 200);
      const ownerProject = await responseJson<{ id: string }>(ownerProjectResponse);
      const ownerUpdateResponse = await apiRequest(first.baseUrl, owner.token, `/api/projects/${ownerProject.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "running" }),
      });
      expectStatus(ownerUpdateResponse, 200);

      const otherProjectResponse = await apiRequest(first.baseUrl, otherUser.token, "/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Private project" }),
      });
      expectStatus(otherProjectResponse, 200);
      const otherProject = await responseJson<{ id: string }>(otherProjectResponse);
      await expectStatus(
        await apiRequest(first.baseUrl, otherUser.token, `/api/projects/${ownerProject.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: "Should be rejected" }),
        }),
        404,
      );

      const webhookResponse = await fetch(`${first.baseUrl}/api/webhooks/test-source/test-token`, { method: "POST" });
      await expectStatus(webhookResponse, 200);

      await stopExample(firstProcess);
      firstProcess = undefined;
      const second = await startExample("kitchen-sink", dataDir);
      secondProcess = second.child;
      const projectsAfterRestart = await responseJson<Array<{ id: string; status: string }>>(
        await apiRequest(second.baseUrl, owner.token, "/api/projects"),
      );
      expect(projectsAfterRestart.map(({ id }) => id)).toContain(ownerProject.id);
      expect(projectsAfterRestart.filter(({ id }) => id === ownerProject.id)[0]?.status).toBe("running");
      expect(projectsAfterRestart.map(({ id }) => id).filter((id) => id.startsWith(`${owner.user.id}:seed:`))).toHaveLength(2);
      expect(projectsAfterRestart.map(({ id }) => id)).not.toContain(otherProject.id);

      const otherProjectsAfterRestart = await responseJson<Array<{ id: string }>>(
        await apiRequest(second.baseUrl, otherUser.token, "/api/projects"),
      );
      expect(otherProjectsAfterRestart.map(({ id }) => id)).toContain(otherProject.id);
      expect(otherProjectsAfterRestart.map(({ id }) => id)).not.toContain(ownerProject.id);
    } finally {
      if (firstProcess) await stopExample(firstProcess);
      if (secondProcess) await stopExample(secondProcess);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("does not publish a Notes TODO success event when durable creation fails", async () => {
    const dataDir = resolve(testRoot, `example-write-failure-notes-${crypto.randomUUID()}`);
    rmSync(dataDir, { recursive: true, force: true });
    const authStore = sqliteWebAppStore({ dataDir });
    authStore.initialize();
    const owner = createIdentity(authStore, "notes-write-failure-owner", "owner");
    const durableStore = createNotesTodoStore({ dataDir });
    const failingStore: NotesTodoStore = {
      ...durableStore,
      createNote: () => {
        throw new Error("intentional Notes TODO durable write failure");
      },
    };
    const app = createNotesTodoApp({ dataDir, store: authStore, appStore: failingStore });
    const events = captureRealtime(app, owner.user.id);

    try {
      const sectionsResponse = await app.handleRequest(new Request("http://localhost/api/sections", {
        headers: { authorization: `Bearer ${owner.token}` },
      }));
      expect(sectionsResponse?.status).toBe(200);
      const sections = await sectionsResponse!.json() as Array<{ id: string }>;
      const response = await app.handleRequest(new Request("http://localhost/api/notes", {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({ title: "Will fail", sectionId: sections[0]!.id }),
      }));
      expect(response?.status).toBe(500);
      expect(events.messages).toHaveLength(0);
    } finally {
      events.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("does not publish a Kitchen Sink success event when durable creation fails", async () => {
    const dataDir = resolve(testRoot, `example-write-failure-kitchen-${crypto.randomUUID()}`);
    rmSync(dataDir, { recursive: true, force: true });
    const authStore = sqliteWebAppStore({ dataDir });
    authStore.initialize();
    const owner = createIdentity(authStore, "kitchen-write-failure-owner", "owner");
    const durableStore = createKitchenSinkStore({ dataDir });
    const failingStore: KitchenSinkStore = {
      ...durableStore,
      createProject: () => {
        throw new Error("intentional Kitchen Sink durable write failure");
      },
    };
    const app = createKitchenSinkApp({ dataDir, store: authStore, appStore: failingStore });
    const events = captureRealtime(app, owner.user.id);

    try {
      const projectsResponse = await app.handleRequest(new Request("http://localhost/api/projects", {
        headers: { authorization: `Bearer ${owner.token}` },
      }));
      expect(projectsResponse?.status).toBe(200);
      const response = await app.handleRequest(new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({ name: "Will fail" }),
      }));
      expect(response?.status).toBe(500);
      expect(events.messages).toHaveLength(0);
    } finally {
      events.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
