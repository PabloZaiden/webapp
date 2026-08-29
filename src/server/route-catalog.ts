import {
  buildCompiledRoutePath,
  compileRoutePatterns,
  compileRouteTable,
  compareRoutePatterns,
  matchCompiledRoutePattern,
  type CompiledRoute,
  type CompiledRoutePatterns,
  type HttpMethod,
  type RouteAuth,
  type RouteTable,
  type SameOriginMode,
} from "./routes";

export interface RouteCatalogEntry {
  path: string;
  cliPath: string;
  methods: HttpMethod[];
  auth: RouteAuth;
  sameOrigin: SameOriginMode;
  scopes: string[];
  description?: string;
  tags: string[];
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
}

export interface RouteCatalogMatch {
  entry: RouteCatalogEntry;
  path: string;
  params: Record<string, string>;
}

const compiledCatalogEntries = new WeakMap<RouteCatalogEntry, CompiledRoutePatterns>();

function normalizeApiPath(input: string): string {
  const [path = ""] = input.trim().split(/[?#]/);
  if (!path) {
    throw new Error("API endpoint is required");
  }
  if (path.startsWith("/api/") || path === "/api") {
    return path;
  }
  if (path.startsWith("api/")) {
    return `/${path}`;
  }
  if (path.startsWith("/")) {
    return path;
  }
  return `/api/${path}`;
}

function normalizeCliPath(input: string): string {
  const [path = ""] = input.trim().split(/[?#]/);
  return path.startsWith("/api/")
    ? path.slice("/api/".length).replace(/^\/+|\/+$/g, "")
    : path.replace(/^\/+|\/+$/g, "");
}

function catalogEntry<TEvent>(compiled: CompiledRoute<TEvent>): RouteCatalogEntry {
  const entry: RouteCatalogEntry = {
    path: compiled.pattern,
    cliPath: compiled.cliPath,
    methods: [...compiled.methods],
    auth: compiled.route.auth ?? "required",
    sameOrigin: compiled.route.sameOrigin ?? "mutations",
    scopes: compiled.route.scopes ?? [],
    description: compiled.route.description,
    tags: compiled.route.tags ?? [],
    requestSchema: compiled.route.requestSchema,
    querySchema: compiled.route.querySchema,
    responseSchema: compiled.route.responseSchema,
  };
  compiledCatalogEntries.set(entry, compiled.patterns);
  return entry;
}

export function createRouteCatalog<TEvent = unknown>(routes: RouteTable<TEvent>): RouteCatalogEntry[] {
  return compileRouteTable(routes).routes
    .filter((compiled) => compiled.route.catalog !== false)
    .map((compiled) => catalogEntry(compiled))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function compiledPatternsForEntry(entry: RouteCatalogEntry): CompiledRoutePatterns {
  const existing = compiledCatalogEntries.get(entry);
  if (existing) {
    return existing;
  }
  const compiled = compileRoutePatterns(entry.path, entry.cliPath);
  compiledCatalogEntries.set(entry, compiled);
  return compiled;
}

export function findRouteCatalogEntry(catalog: readonly RouteCatalogEntry[], input: string): RouteCatalogMatch | undefined {
  const apiPath = normalizeApiPath(input);
  const cliPath = normalizeCliPath(input);
  const sorted = catalog
    .map((entry) => ({ entry, patterns: compiledPatternsForEntry(entry) }))
    .sort((left, right) => {
      const specificity = compareRoutePatterns(left.patterns.api, right.patterns.api);
      return specificity || left.entry.path.localeCompare(right.entry.path);
    });
  for (const { entry, patterns } of sorted) {
    const apiMatch = matchCompiledRoutePattern(patterns.api, apiPath);
    if (apiMatch.kind === "matched") {
      return { entry, path: apiPath, params: apiMatch.params };
    }
    const cliMatch = matchCompiledRoutePattern(patterns.cli, cliPath);
    if (cliMatch.kind === "matched") {
      return {
        entry,
        path: buildCompiledRoutePath(patterns.api, cliMatch.captures),
        params: cliMatch.params,
      };
    }
  }
  return undefined;
}
