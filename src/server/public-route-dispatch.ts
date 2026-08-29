import type {
  PublicRouteAsset,
  PublicRouteDefinition,
  PublicRouteValue,
} from "./server-types";
import { webAppPublicAssetRouteMetadata } from "./public-assets";
import type { WebAppPublicAssetBundle } from "./public-asset-manifest";
import type { WebDocument } from "./web-document";
import { methodNotAllowed, notFound, responseForRequest, withSecurityHeaders } from "./responses";

export interface PublicRouteDispatcherDependencies {
  publicRoutes: Readonly<Record<string, PublicRouteDefinition>>;
  generatedRoutePaths: ReadonlySet<string>;
  ensureWebDocument: () => Promise<WebDocument>;
}

export interface PublicRouteDispatcher {
  (req: Request): Promise<Response | undefined>;
  dispatch(req: Request): Promise<Response | undefined>;
  ensurePublicAssetPaths(): Promise<ReadonlySet<string>>;
}

function hasOwnPublicRoute(publicRoutes: Readonly<Record<string, PublicRouteDefinition>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(publicRoutes, path);
}

interface PublicAssetRouteClaim {
  route: PublicRouteDefinition;
  registeredPath: string;
}

async function preparePublicAssetRoutes(
  publicRoutes: Readonly<Record<string, PublicRouteDefinition>>,
  generatedRoutePaths: ReadonlySet<string>,
): Promise<ReadonlyMap<string, PublicAssetRouteClaim>> {
  const bundles: Array<{
    registeredPath: string;
    route: PublicRouteDefinition;
    bundle: WebAppPublicAssetBundle;
  }> = [];
  for (const [registeredPath, route] of Object.entries(publicRoutes)) {
    const metadata = webAppPublicAssetRouteMetadata(route);
    if (!metadata) continue;
    const bundle = await metadata.getBundle();
    if (bundle.entry !== metadata.primaryPath || bundle.entry !== registeredPath) {
      throw new Error(`Public asset route ${registeredPath} does not match its configured primary path ${bundle.entry}`);
    }
    bundles.push({ registeredPath, route, bundle });
  }

  const claims = new Map<string, PublicAssetRouteClaim>();
  for (const { registeredPath, route, bundle } of bundles) {
    for (const artifact of bundle.artifacts) {
      if (generatedRoutePaths.has(artifact.path)) {
        throw new Error(`Public asset path ${artifact.path} collides with a framework-owned web route`);
      }
      if (
        artifact.path !== registeredPath
        && hasOwnPublicRoute(publicRoutes, artifact.path)
        && publicRoutes[artifact.path] !== undefined
      ) {
        throw new Error(`Public asset path ${artifact.path} collides with public route ${artifact.path}`);
      }
      const existing = claims.get(artifact.path);
      if (existing && existing.route !== route) {
        throw new Error(
          `Duplicate public asset path ${artifact.path} from routes ${existing.registeredPath} and ${registeredPath}`,
        );
      }
      claims.set(artifact.path, { route, registeredPath });
    }
  }
  return claims;
}

function publicAssetResponse(asset: PublicRouteAsset, extraHeaders?: HeadersInit): Response {
  const response = asset instanceof Response
    ? asset.clone()
    : typeof asset === "string"
      ? new Response(asset, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : new Response(asset as BodyInit);
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders)) {
      response.headers.set(name, value);
    }
  }
  return withSecurityHeaders(response);
}

async function handlePublicRouteValue(req: Request, route: PublicRouteDefinition): Promise<Response> {
  const methodName = req.method === "HEAD" ? "HEAD" : req.method === "GET" ? "GET" : undefined;
  if (!methodName) {
    return responseForRequest(req, withSecurityHeaders(methodNotAllowed()));
  }
  const definition = typeof route === "object"
    && route !== null
    && !(route instanceof Response)
    && !(route instanceof Blob)
    && !(route instanceof ArrayBuffer)
    && !(route instanceof Uint8Array)
    && ("GET" in route || "HEAD" in route || "headers" in route)
    ? route
    : undefined;
  const value = definition
    ? definition[methodName] ?? (methodName === "HEAD" ? definition.GET : undefined)
    : route as PublicRouteValue;
  if (value === undefined) {
    return responseForRequest(req, withSecurityHeaders(methodNotAllowed()));
  }
  const asset = typeof value === "function" ? await value(req) : value;
  if (asset === undefined) {
    return responseForRequest(req, withSecurityHeaders(notFound()));
  }
  const response = publicAssetResponse(asset, definition?.headers);
  return responseForRequest(req, response);
}

export function createPublicRouteDispatcher(dependencies: PublicRouteDispatcherDependencies): PublicRouteDispatcher {
  const { publicRoutes, generatedRoutePaths, ensureWebDocument } = dependencies;
  let publicAssetRoutesPromise: Promise<ReadonlyMap<string, PublicAssetRouteClaim>> | undefined;
  const ensurePublicAssetRoutes = (): Promise<ReadonlyMap<string, PublicAssetRouteClaim>> =>
    publicAssetRoutesPromise ??= preparePublicAssetRoutes(publicRoutes, generatedRoutePaths);

  async function dispatch(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const publicAssetRoutes = await ensurePublicAssetRoutes();
    if (generatedRoutePaths.has(url.pathname)) {
      const webDocument = await ensureWebDocument();
      const generatedRoute = webDocument.generatedPublicRoutes[url.pathname];
      if (generatedRoute !== undefined) {
        return handlePublicRouteValue(req, generatedRoute);
      }
    }
    if (hasOwnPublicRoute(publicRoutes, url.pathname)) {
      const route = publicRoutes[url.pathname];
      if (route !== undefined) {
        return handlePublicRouteValue(req, route);
      }
    }
    const publicAssetRoute = publicAssetRoutes.get(url.pathname);
    if (!publicAssetRoute) {
      return undefined;
    }
    return handlePublicRouteValue(req, publicAssetRoute.route);
  }

  return Object.assign(dispatch, {
    dispatch,
    async ensurePublicAssetPaths(): Promise<ReadonlySet<string>> {
      return new Set((await ensurePublicAssetRoutes()).keys());
    },
  });
}
