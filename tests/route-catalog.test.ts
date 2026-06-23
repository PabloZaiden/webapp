import { describe, expect, test } from "bun:test";
import { createRouteCatalog, defineRoutes, findRouteCatalogEntry, jsonResponse } from "@pablozaiden/webapp/server";

describe("route catalog", () => {
  const routes = defineRoutes({
    "/api/tasks": {
      auth: "user",
      description: "List tasks.",
      tags: ["tasks"],
      GET: () => jsonResponse([]),
      POST: () => jsonResponse({ ok: true }),
    },
    "/api/tasks/:id": {
      auth: "user",
      scopes: ["tasks:read"],
      cliPath: "task/:id",
      description: "Read a task.",
      GET: () => jsonResponse({ id: "task" }),
    },
    "/task/:taskId/port/:forwardId": {
      auth: "user",
      catalog: false,
      GET: () => jsonResponse({ ok: true }),
    },
  });

  test("derives catalog metadata and methods from route handlers", () => {
    const catalog = createRouteCatalog(routes);

    expect(catalog).toHaveLength(2);
    expect(catalog[0]).toMatchObject({
      path: "/api/tasks",
      cliPath: "tasks",
      methods: ["GET", "POST"],
      auth: "user",
      sameOrigin: "mutations",
      description: "List tasks.",
      tags: ["tasks"],
    });
  });

  test("matches exact API paths, CLI paths and parameterized entries", () => {
    const catalog = createRouteCatalog(routes);

    expect(findRouteCatalogEntry(catalog, "/api/tasks")?.entry.path).toBe("/api/tasks");
    expect(findRouteCatalogEntry(catalog, "task/123")).toMatchObject({
      entry: { path: "/api/tasks/:id" },
      path: "/api/tasks/123",
      params: { id: "123" },
    });
    expect(findRouteCatalogEntry(catalog, "/api/tasks/abc")).toMatchObject({
      entry: { path: "/api/tasks/:id" },
      params: { id: "abc" },
    });
  });
});
