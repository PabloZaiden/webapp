import { describe, expect, test } from "bun:test";
import {
  createRouteCatalog,
  createWebAppServer,
  compileRouteTable,
  defineRoutes,
  findRouteCatalogEntry,
  jsonResponse,
  matchRoute,
  type RouteTable,
  sqliteWebAppStore,
} from "@pablozaiden/webapp/server";

const routeCalls: string[] = [];

const routes = defineRoutes({
  "/api/status": {
    auth: "public",
    sameOrigin: "never",
    GET: () => {
      routeCalls.push("status:GET");
      return jsonResponse({ ok: true });
    },
    POST: () => {
      routeCalls.push("status:POST");
      return jsonResponse({ created: true });
    },
  },
  "/api/items/:id": {
    auth: "public",
    sameOrigin: "never",
    cliPath: "item/:taskId",
    GET: (_req, ctx) => {
      routeCalls.push(`item:${ctx.params["id"]!}`);
      return jsonResponse({ id: ctx.params["id"] });
    },
  },
  "/api/files/*": {
    auth: "public",
    sameOrigin: "never",
    cliPath: "files/*",
    GET: (_req, ctx) => {
      routeCalls.push(`files:${ctx.params["*"]!}`);
      return jsonResponse({ path: ctx.params["*"] });
    },
  },
});

const catalog = createRouteCatalog(routes);
const app = createWebAppServer({
  appName: "Route contract test",
  envPrefix: "ROUTE_CONTRACT_TEST",
  store: sqliteWebAppStore({ dataDir: `.cache/tests/route-contract-${crypto.randomUUID()}` }),
  auth: { passkeys: false },
  routes,
});

async function responseJson<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

interface RouteCase {
  name: string;
  apiInput: string;
  cliInput: string;
  expectedPath: string;
  expectedParams: Record<string, string>;
}

const routeCases: RouteCase[] = [
  {
    name: "static",
    apiInput: "/api/status?check=1#fragment",
    cliInput: "status",
    expectedPath: "/api/status",
    expectedParams: {},
  },
  {
    name: "named",
    apiInput: "/api/items/123",
    cliInput: "item/123",
    expectedPath: "/api/items/123",
    expectedParams: { id: "123" },
  },
  {
    name: "encoded named value",
    apiInput: "/api/items/a%2Fb",
    cliInput: "item/a%2Fb",
    expectedPath: "/api/items/a%2Fb",
    expectedParams: { id: "a/b" },
  },
  {
    name: "empty trailing wildcard",
    apiInput: "/api/files",
    cliInput: "files",
    expectedPath: "/api/files",
    expectedParams: { "*": "" },
  },
  {
    name: "multi-segment trailing wildcard",
    apiInput: "/api/files/a/b%20c?download=true",
    cliInput: "files/a/b%20c#details",
    expectedPath: "/api/files/a/b%20c",
    expectedParams: { "*": "a/b c" },
  },
];

describe("shared route contract", () => {
  test("reuses the compiled route table for the same route-table object", () => {
    expect(compileRouteTable(routes)).toBe(compileRouteTable(routes));
  });

  for (const routeCase of routeCases) {
    test(`matches ${routeCase.name} through runtime and catalog paths`, async () => {
      const runtimeMatch = matchRoute(routes, routeCase.apiInput.split(/[?#]/)[0]!);
      expect(runtimeMatch?.params).toEqual(routeCase.expectedParams);

      const apiMatch = findRouteCatalogEntry(catalog, routeCase.apiInput);
      expect(apiMatch).toMatchObject({
        path: routeCase.expectedPath,
        params: routeCase.expectedParams,
      });

      const cliMatch = findRouteCatalogEntry(catalog, routeCase.cliInput);
      expect(cliMatch).toMatchObject({
        path: routeCase.expectedPath,
      });

      const response = await app.handleRequest(new Request(`http://localhost${routeCase.expectedPath}`));
      expect(response?.status).toBe(200);
    });
  }

  test("maps differently named alias captures positionally", () => {
    const match = findRouteCatalogEntry(catalog, "item/a%2Fb");

    expect(match).toMatchObject({
      entry: { path: "/api/items/:id", cliPath: "item/:taskId" },
      path: "/api/items/a%2Fb",
      params: { taskId: "a/b" },
    });
  });

  test("returns a structured client error for malformed dynamic encoding", async () => {
    routeCalls.length = 0;

    const named = await app.handleRequest(new Request("http://localhost/api/items/%E0%A4%A"));
    const wildcard = await app.handleRequest(new Request("http://localhost/api/files/%E0%A4%A"));

    expect(named?.status).toBe(400);
    expect(await responseJson<{ error: string }>(named)).toMatchObject({ error: "invalid_path" });
    expect(wildcard?.status).toBe(400);
    expect(await responseJson<{ error: string }>(wildcard)).toMatchObject({ error: "invalid_path" });
    expect(routeCalls).toEqual([]);
  });

  test("returns 405 and Allow without falling back to GET", async () => {
    routeCalls.length = 0;

    for (const method of ["OPTIONS", "TRACE", "DELETE"]) {
      const response = await app.handleRequest(new Request("http://localhost/api/status", { method }));

      expect(response?.status).toBe(405);
      expect(response?.headers.get("allow")).toBe("GET, POST");
      expect(await responseJson<{ error: string }>(response)).toMatchObject({ error: "method_not_allowed" });
    }

    const head = await app.handleRequest(new Request("http://localhost/api/status", { method: "HEAD" }));

    expect(head?.status).toBe(200);
    expect(head?.body).toBeNull();
    expect(routeCalls).toEqual(["status:GET"]);
  });

  test("rejects invalid and ambiguous route definitions at construction", () => {
    const handler = () => jsonResponse({ ok: true });
    const create = (input: RouteTable) => createWebAppServer({
      appName: "Invalid route test",
      envPrefix: "INVALID_ROUTE_TEST",
      store: sqliteWebAppStore({ dataDir: `.cache/tests/invalid-route-${crypto.randomUUID()}` }),
      auth: { passkeys: false },
      routes: input,
    });

    expect(() => create(defineRoutes({
      "/api/files/*/extra": { auth: "public", sameOrigin: "never", GET: handler },
    }))).toThrow(/trailing segment/);
    expect(() => create(defineRoutes({
      "/api/items/:id": { auth: "public", sameOrigin: "never", cliPath: "item", GET: handler },
    }))).toThrow(/same ordered parameter/);
    expect(() => create(defineRoutes({
      "/api/items/:id": { auth: "public", sameOrigin: "never", GET: handler },
      "/api/items/:otherId": { auth: "public", sameOrigin: "never", GET: handler },
    }))).toThrow(/ambiguous|same API pattern/);
  });
});
