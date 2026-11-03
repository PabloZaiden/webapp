import {
  buildCompiledRoutePath, compileRoutePatterns, compileRouteTable, compareRoutePatterns,
  matchCompiledRoutePattern, HTTP_METHODS,
  type CompiledRoutePatterns, type HttpMethod, type RoutePatternDefinition,
} from "./routes";

export type RouteCatalogEntry<TRoute extends RoutePatternDefinition = RoutePatternDefinition> =
  Omit<TRoute, HttpMethod | "cliPath"> & { path: string; cliPath: string; methods: HttpMethod[] };

export interface RouteCatalogMatch<TRoute extends RoutePatternDefinition = RoutePatternDefinition> {
  entry: RouteCatalogEntry<TRoute>;
  path: string;
  params: Record<string, string>;
}

export function createRouteCatalog<TRoute extends RoutePatternDefinition>(routes: Record<string, TRoute>): RouteCatalogEntry<TRoute>[] {
  return compileRouteTable(routes).routes.filter(compiled => compiled.route.catalog !== false).map(compiled => ({
    ...Object.fromEntries(Object.entries(compiled.route).filter(([key]) => !HTTP_METHODS.includes(key as HttpMethod))),
    path: compiled.pattern, cliPath: compiled.cliPath, methods: [...compiled.methods],
  } as RouteCatalogEntry<TRoute>)).sort((left, right) => left.path.localeCompare(right.path));
}

const patterns = new WeakMap<object, CompiledRoutePatterns>();
function compiledPatterns(entry: RouteCatalogEntry): CompiledRoutePatterns {
  let value = patterns.get(entry);
  if (!value) {
    value = compileRoutePatterns(entry.path, entry.cliPath);
    patterns.set(entry, value);
  }
  return value;
}

export function findRouteCatalogEntry<TRoute extends RoutePatternDefinition>(
  catalog: readonly RouteCatalogEntry<TRoute>[], input: string,
): RouteCatalogMatch<TRoute> | undefined {
  const [trimmed = ""] = input.trim().split(/[?#]/);
  if (!trimmed) throw new Error("An endpoint is required");
  const api = trimmed.startsWith("/") ? trimmed : trimmed.startsWith("api/") ? `/${trimmed}` : `/api/${trimmed}`;
  const cli = trimmed.replace(/^\/?api\//, "").replace(/^\/+|\/+$/g, "");
  const sorted = catalog.map(entry => ({ entry, patterns: compiledPatterns(entry) }))
    .sort((a, b) => compareRoutePatterns(a.patterns.api, b.patterns.api) || a.entry.path.localeCompare(b.entry.path));
  for (const surface of trimmed.startsWith("/") || trimmed.startsWith("api/") ? ["api", "cli"] as const : ["cli", "api"] as const) {
    for (const { entry, patterns: compiled } of sorted) {
      const match = matchCompiledRoutePattern(compiled[surface], surface === "api" ? api : cli);
      if (match.kind === "matched") return {
        entry, path: surface === "api" ? api : buildCompiledRoutePath(compiled.api, match.captures), params: match.params,
      };
    }
  }
  return undefined;
}
