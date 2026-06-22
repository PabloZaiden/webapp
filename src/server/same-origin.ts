import type { AuthenticatedRequestState } from "./auth/types";
import { getRequestOriginInfo } from "./auth/request-origin";
import type { RuntimeConfig } from "./runtime-config";
import { errorResponse } from "./responses";
import type { SameOriginMode } from "./routes";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function checkSameOrigin(req: Request, config: RuntimeConfig, auth: AuthenticatedRequestState, mode: SameOriginMode = "mutations"): Response | undefined {
  if (config.sameOriginDisabled || mode === "never") {
    return undefined;
  }
  const mutating = MUTATING.has(req.method.toUpperCase());
  const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (mode !== "always" && !mutating && !websocket) {
    return undefined;
  }
  if (mode !== "always" && (auth.kind === "api-key" || auth.kind === "bearer")) {
    return undefined;
  }
  const expectedOrigin = getRequestOriginInfo(req, config.publicBaseUrl).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    return origin === expectedOrigin ? undefined : errorResponse(403, "same_origin_required", "Request origin is not allowed");
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin ? undefined : errorResponse(403, "same_origin_required", "Request origin is not allowed");
    } catch {
      return errorResponse(403, "same_origin_required", "Request origin is not allowed");
    }
  }
  return errorResponse(403, "same_origin_required", "Request origin is not allowed");
}
