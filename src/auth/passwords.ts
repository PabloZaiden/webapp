import { AuthBonusError, authenticationOrigin, requireAuthenticationOrigin, validVersion } from "./common";

export interface PasswordCredential { identityId: string; hash: string; version: number }
export interface PasswordAttempt {
  action: "enroll" | "login" | "change";
  identityId?: string;
  username?: string;
  request: Request;
}
export interface PasswordAuthOptions {
  origin: string;
  getCredential(username: string): PasswordCredential | undefined | Promise<PasswordCredential | undefined>;
  getCredentialByIdentity(identityId: string): PasswordCredential | undefined | Promise<PasswordCredential | undefined>;
  /** Atomic insert/CAS, also advances the identity's browser-session epoch. */
  setCredential(identityId: string, expectedVersion: number | undefined, credential: Omit<PasswordCredential, "identityId">): boolean | Promise<boolean>;
  /** Required application-owned attempt/concurrency limiting, before expensive hashing. */
  allowAttempt(attempt: PasswordAttempt): boolean | Promise<boolean>;
}

const HASH_OPTIONS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
function password(value: string, enrollment: boolean): void {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 || value.length < (enrollment ? 12 : 1)) {
    throw new AuthBonusError("invalid_password", enrollment ? "Passwords must contain at least 12 characters and at most 1024 bytes." : "Invalid credentials.", 400);
  }
}
function credential(value: PasswordCredential | undefined): void {
  if (!value) return;
  validVersion(value.version);
  const parameters = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]{8,128}\$[A-Za-z0-9+/]{16,128}$/.exec(value.hash);
  if (typeof value.identityId !== "string" || !value.identityId || typeof value.hash !== "string" || value.hash.length > 1024
    || !parameters || Number(parameters[1]) < 8 || Number(parameters[1]) > 65536
    || Number(parameters[2]) < 1 || Number(parameters[2]) > 6
    || Number(parameters[3]) < 1 || Number(parameters[3]) > 4) throw new TypeError("Invalid stored password credential.");
}

/** Enrollment requires an identity already authorized by the calling application. */
export function createPasswordAuth(options: PasswordAuthOptions) {
  const origin = authenticationOrigin(options.origin).origin;
  let dummyHash: Promise<string> | undefined;
  async function allow(attempt: PasswordAttempt): Promise<void> {
    requireAuthenticationOrigin(attempt.request, origin);
    if (!await options.allowAttempt(attempt)) throw new AuthBonusError("too_many_attempts", "Try again later.", 429);
  }
  async function save(identityId: string, expectedVersion: number | undefined, value: string) {
    const version = (expectedVersion ?? 0) + 1;
    validVersion(version);
    const hash = await Bun.password.hash(value, HASH_OPTIONS);
    if (!await options.setCredential(identityId, expectedVersion, { hash, version })) {
      throw new AuthBonusError("credential_changed", "Credentials changed. Try again.", 409);
    }
    return { identityId, version };
  }
  return {
    async enroll(req: Request, authorizedIdentityId: string, value: string) {
      await allow({ action: "enroll", identityId: authorizedIdentityId, request: req });
      password(value, true);
      if (!authorizedIdentityId) throw new AuthBonusError("identity_required", "An authorized identity is required.", 403);
      const existing = await options.getCredentialByIdentity(authorizedIdentityId);
      credential(existing);
      if (existing) throw new AuthBonusError("credential_exists", "A password is already enrolled.", 409);
      return await save(authorizedIdentityId, undefined, value);
    },
    async verify(req: Request, username: string, value: string): Promise<{ identityId: string; version: number } | undefined> {
      if (typeof username !== "string" || !username || username.length > 256) throw new AuthBonusError("invalid_credentials", "Invalid credentials.", 400);
      await allow({ action: "login", username, request: req });
      password(value, false);
      const found = await options.getCredential(username);
      credential(found);
      const hash = found?.hash ?? await (dummyHash ??= Bun.password.hash(crypto.randomUUID(), HASH_OPTIONS));
      const verified = await Bun.password.verify(value, hash);
      return found && verified ? { identityId: found.identityId, version: found.version } : undefined;
    },
    async change(req: Request, identityId: string, currentPassword: string, nextPassword: string) {
      await allow({ action: "change", identityId, request: req });
      password(currentPassword, false);
      password(nextPassword, true);
      const found = await options.getCredentialByIdentity(identityId);
      credential(found);
      if (!found || !await Bun.password.verify(currentPassword, found.hash)) {
        throw new AuthBonusError("invalid_credentials", "Invalid credentials.", 401);
      }
      return await save(identityId, found.version, nextPassword);
    },
  };
}
