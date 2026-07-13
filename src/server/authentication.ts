import type { CurrentUser } from "../contracts";
import { authenticateApiKey, assertScopes } from "./auth/api-keys";
import {
  getPasskeySessionUser,
  isPasskeyAuthRequired,
} from "./auth/passkeys";
import { verifyAccessToken } from "./auth/device-auth";
import { createUserRecord } from "./auth/users";
import type { WebAppStore } from "./auth/store";
import { AuthError, type AuthenticatedRequestState } from "./auth/types";
import { errorResponse, jsonResponse, requestBodyErrorResponse } from "./responses";
import type { RuntimeConfig } from "./runtime-config";
import type { RouteAuth, UserIdSelector, UserOwnedResource } from "./routes";

export interface AuthenticationDependencies {
  store: WebAppStore;
  config: RuntimeConfig;
  passkeysEnabled: boolean;
  apiKeysEnabled: boolean;
  deviceAuthEnabled: boolean;
}

export interface Authentication {
  authorize(req: Request, required: boolean): Promise<AuthenticatedRequestState | Response>;
  configUser(req: Request): CurrentUser | undefined;
  currentUser(auth: AuthenticatedRequestState): CurrentUser | undefined;
  requireUser(auth: AuthenticatedRequestState): CurrentUser;
  requireAdmin(auth: AuthenticatedRequestState): CurrentUser;
  requireOwner(auth: AuthenticatedRequestState): CurrentUser;
  assertUser(auth: AuthenticatedRequestState, userId: string): CurrentUser;
  createFilterOwned(auth: AuthenticatedRequestState): <TResource extends UserOwnedResource>(resources: readonly TResource[]) => TResource[];
  createRequireOwned(auth: AuthenticatedRequestState): <TResource extends UserOwnedResource>(resource: TResource | null | undefined) => TResource;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization")?.trim();
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

export function scopesFromBearer(claims: { scope: string }): string[] {
  return claims.scope.split(/\s+/).filter(Boolean);
}

function toCurrentUserRecord(user: { id: string; username: string; role: "owner" | "admin" | "user" }): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    isOwner: user.role === "owner",
    isAdmin: user.role === "owner" || user.role === "admin",
  };
}

function ownedUserId<TResource>(resource: TResource, getUserId?: UserIdSelector<TResource>): string | undefined {
  if (getUserId) {
    return getUserId(resource);
  }
  if (typeof resource === "object" && resource !== null && "userId" in resource && typeof resource.userId === "string") {
    return resource.userId;
  }
  throw new AuthError("route_misconfigured", "Owned resource helpers require a string userId field or a getUserId selector", 500);
}

function requireOwned<TResource extends UserOwnedResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined): TResource;
function requireOwned<TResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
function requireOwned<TResource>(auth: AuthenticatedRequestState, resource: TResource | null | undefined, getUserId?: UserIdSelector<TResource>): TResource {
  const user = requireUser(auth);
  const resourceUserId = resource ? ownedUserId(resource, getUserId) : undefined;
  if (!resource || resourceUserId !== user.id) {
    throw new AuthError("not_found", "Resource not found", 404);
  }
  return resource;
}

function filterOwned<TResource extends UserOwnedResource>(auth: AuthenticatedRequestState, resources: readonly TResource[]): TResource[];
function filterOwned<TResource>(auth: AuthenticatedRequestState, resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
function filterOwned<TResource>(auth: AuthenticatedRequestState, resources: readonly TResource[], getUserId?: UserIdSelector<TResource>): TResource[] {
  const user = requireUser(auth);
  return resources.filter((resource) => ownedUserId(resource, getUserId) === user.id);
}

function currentUser(auth: AuthenticatedRequestState): CurrentUser | undefined {
  return auth.kind === "anonymous" ? undefined : auth.user;
}

function requireUser(auth: AuthenticatedRequestState): CurrentUser {
  const user = currentUser(auth);
  if (!user) {
    throw new AuthError("authentication_required", "Authentication is required", 401);
  }
  return user;
}

function requireAdmin(auth: AuthenticatedRequestState): CurrentUser {
  const user = requireUser(auth);
  if (!user.isAdmin) {
    throw new AuthError("admin_required", "Admin permissions are required", 403);
  }
  return user;
}

function requireOwner(auth: AuthenticatedRequestState): CurrentUser {
  const user = requireUser(auth);
  if (!user.isOwner) {
    throw new AuthError("owner_required", "Owner permissions are required", 403);
  }
  return user;
}

function assertUser(auth: AuthenticatedRequestState, userId: string): CurrentUser {
  const user = requireUser(auth);
  if (user.id !== userId) {
    throw new AuthError("forbidden", "You cannot access another user's resource", 403);
  }
  return user;
}

export function createFilterOwned(auth: AuthenticatedRequestState) {
  function contextFilterOwned<TResource extends UserOwnedResource>(resources: readonly TResource[]): TResource[];
  function contextFilterOwned<TResource>(resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
  function contextFilterOwned<TResource>(resources: readonly TResource[], getUserId?: UserIdSelector<TResource>): TResource[] {
    return filterOwned(auth, resources, getUserId as UserIdSelector<TResource>);
  }
  return contextFilterOwned;
}

export function createRequireOwned(auth: AuthenticatedRequestState) {
  function contextRequireOwned<TResource extends UserOwnedResource>(resource: TResource | null | undefined): TResource;
  function contextRequireOwned<TResource>(resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
  function contextRequireOwned<TResource>(resource: TResource | null | undefined, getUserId?: UserIdSelector<TResource>): TResource {
    return requireOwned(auth, resource, getUserId as UserIdSelector<TResource>);
  }
  return contextRequireOwned;
}

export function requiresAuth(routeAuth: RouteAuth): boolean {
  return routeAuth !== "public" && routeAuth !== "optional";
}

export function enforceRouteAuth(routeAuth: RouteAuth, auth: AuthenticatedRequestState, authentication: Authentication): void {
  if (routeAuth === "user") {
    authentication.requireUser(auth);
  } else if (routeAuth === "admin") {
    authentication.requireAdmin(auth);
  } else if (routeAuth === "owner") {
    authentication.requireOwner(auth);
  }
}

export function tokenError(error: unknown): Response {
  if (error instanceof AuthError) {
    return jsonResponse({ error: error.code, error_description: error.message }, { status: error.status });
  }
  return jsonResponse({ error: "server_error", error_description: "An unexpected auth error occurred" }, { status: 500 });
}

export function authErrorResponse(error: unknown): Response {
  const requestBodyFailure = requestBodyErrorResponse(error);
  if (requestBodyFailure) {
    return requestBodyFailure;
  }
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  return errorResponse(500, "request_failed", "Request failed");
}

export function createAuthentication(dependencies: AuthenticationDependencies): Authentication {
  const { store, config, passkeysEnabled, apiKeysEnabled, deviceAuthEnabled } = dependencies;

  function disabledAuthOwner(): CurrentUser {
    const existing = store.getOwnerUser();
    if (existing) {
      return toCurrentUserRecord(existing);
    }
    const owner = createUserRecord({ username: "admin", role: "owner" });
    store.createUser(owner);
    return toCurrentUserRecord(owner);
  }

  async function authorize(req: Request, required: boolean): Promise<AuthenticatedRequestState | Response> {
    const token = bearerToken(req);
    if (token) {
      if (deviceAuthEnabled) {
        try {
          const claims = await verifyAccessToken(store, config, token);
          const user = store.getUserById(claims.sub);
          if (user) {
            return {
              kind: "bearer",
              claims,
              user: {
                id: user.id,
                username: user.username,
                role: user.role,
                isOwner: user.role === "owner",
                isAdmin: user.role === "owner" || user.role === "admin",
              },
            };
          }
        } catch {
          // Fall through to API keys.
        }
      }
      if (apiKeysEnabled) {
        const apiKey = authenticateApiKey(store, token);
        if (apiKey) {
          return { kind: "api-key", ...apiKey };
        }
      }
      return errorResponse(401, "invalid_token", "****** is invalid");
    }
    if (passkeysEnabled) {
      if (config.passkeyDisabled) {
        return { kind: "passkey", user: disabledAuthOwner() };
      }
      const user = getPasskeySessionUser(req, store, config);
      if (user) {
        return { kind: "passkey", user };
      }
    }
    if (passkeysEnabled && isPasskeyAuthRequired(store, config)) {
      const user = getPasskeySessionUser(req, store, config);
      if (!user) {
        return required ? errorResponse(401, "authentication_required", "Passkey authentication is required", undefined, {
          headers: { "x-webapp-passkey-required": "true" },
        }) : { kind: "anonymous" };
      }
    }
    if (required && passkeysEnabled && !config.passkeyDisabled && store.countUsers() === 0) {
      return errorResponse(401, "authentication_required", "Passkey authentication is required", undefined, {
        headers: { "x-webapp-passkey-required": "true" },
      });
    }
    return { kind: "anonymous" };
  }

  function configUser(req: Request): CurrentUser | undefined {
    if (!passkeysEnabled) {
      return undefined;
    }
    if (config.passkeyDisabled) {
      return disabledAuthOwner();
    }
    return getPasskeySessionUser(req, store, config);
  }

  return {
    authorize,
    configUser,
    currentUser,
    requireUser,
    requireAdmin,
    requireOwner,
    assertUser,
    createFilterOwned,
    createRequireOwned,
  };
}

export { assertScopes };
