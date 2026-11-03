import { SignJWT, jwtVerify, errors } from "jose";
import { AuthBonusError, authenticationOrigin, requireAuthenticationOrigin, validVersion } from "./common";

export interface BrowserSession {
  id: string;
  identityId: string;
  version: number;
  issuedAt: number;
  expiresAt: number;
}

export interface BrowserSessionOptions<TIdentity> {
  secret: Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
  origin: string;
  cookie: { name: string; path?: string; maxAgeSeconds?: number };
  getIdentity(id: string): TIdentity | undefined | Promise<TIdentity | undefined>;
  getVersion(identity: TIdentity): number | Promise<number>;
  isSessionValid?(session: Readonly<BrowserSession>): boolean | Promise<boolean>;
  onCreate?(session: Readonly<BrowserSession>): void | Promise<void>;
  onRevoke?(session: Readonly<BrowserSession>): void | Promise<void>;
}

/** Signing keys, identity epochs and optional session inventory belong to the app. */
export function createBrowserSessions<TIdentity>(options: BrowserSessionOptions<TIdentity>) {
  const origin = authenticationOrigin(options.origin);
  const { name, path = "/", maxAgeSeconds = 7 * 24 * 60 * 60 } = options.cookie;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !path.startsWith("/") || /[;\s?#\\]/.test(path)
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 366 * 24 * 60 * 60
    || (name.startsWith("__Host-") && (path !== "/" || origin.protocol !== "https:"))
    || (name.startsWith("__Secure-") && origin.protocol !== "https:")) throw new TypeError("Invalid browser session cookie configuration.");
  async function secret(): Promise<Uint8Array> {
    const value = typeof options.secret === "function" ? await options.secret() : options.secret;
    if (!(value instanceof Uint8Array) || value.byteLength < 32) throw new TypeError("Session signing secrets require at least 32 bytes.");
    return value;
  }
  function cookie(token: string, maxAge = maxAgeSeconds): string {
    if (!/^[A-Za-z0-9._-]*$/.test(token)) throw new TypeError("Invalid session cookie token.");
    return [`${name}=${token}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, origin.protocol === "https:" ? "Secure" : ""].filter(Boolean).join("; ");
  }
  async function authenticate(req: Request): Promise<{ identity: TIdentity; session: BrowserSession } | undefined> {
    const candidates = (req.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    if (candidates.length !== 1) return undefined;
    const token = candidates[0]!.slice(name.length + 1);
    if (!token || token.length > 4096) return undefined;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, await secret(), { algorithms: ["HS256"], issuer: origin.origin, audience: name }));
    } catch (error) {
      if (error instanceof errors.JOSEError) return undefined;
      throw error;
    }
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string"
      || typeof payload.iat !== "number" || typeof payload.exp !== "number"
      || !Number.isSafeInteger(payload["version"]) || Number(payload["version"]) < 0) return undefined;
    const session: BrowserSession = {
      id: payload.jti, identityId: payload.sub, version: Number(payload["version"]),
      issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000,
    };
    const identity = await options.getIdentity(session.identityId);
    if (identity === undefined || await options.getVersion(identity) !== session.version
      || (options.isSessionValid && !await options.isSessionValid(session))) return undefined;
    return { identity, session };
  }
  return {
    cookie,
    authenticate,
    async create(identityId: string, { expectedVersion }: { expectedVersion?: number } = {}) {
      const identity = await options.getIdentity(identityId);
      if (identity === undefined) throw new TypeError("Cannot create a session for an unavailable identity.");
      const version = await options.getVersion(identity);
      validVersion(version);
      if (expectedVersion !== undefined && version !== expectedVersion) {
        throw new AuthBonusError("identity_changed", "Identity changed. Sign in again.", 409);
      }
      const issuedAt = Math.floor(Date.now() / 1000);
      const session: BrowserSession = {
        id: crypto.randomUUID(), identityId, version, issuedAt: issuedAt * 1000, expiresAt: (issuedAt + maxAgeSeconds) * 1000,
      };
      const token = await new SignJWT({ version }).setProtectedHeader({ alg: "HS256" })
        .setIssuer(origin.origin).setAudience(name).setSubject(identityId).setJti(session.id)
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + maxAgeSeconds).sign(await secret());
      await options.onCreate?.(session);
      return { token, session, cookie: cookie(token) };
    },
    async logout(req: Request): Promise<string> {
      requireAuthenticationOrigin(req, origin.origin);
      const current = await authenticate(req);
      if (current) await options.onRevoke?.(current.session);
      return cookie("", 0);
    },
  };
}
