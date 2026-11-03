import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AuthBonusError, authenticationOrigin, requireAuthenticationOrigin, validVersion } from "./common";
import { createPasskeyCeremonies, type PasskeyCeremonyOptions } from "./passkey-ceremonies";

export interface PasskeyIdentity {
  id: string;
  username: string;
  displayName?: string;
  /** Stable existing RP user handle; never generate a new handle during migration. */
  userHandle: Uint8Array<ArrayBuffer>;
  version: number;
}
export interface PasskeyCredential {
  credentialId: string;
  identityId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports?: readonly string[];
}
export interface PasskeyChallenge {
  id: string;
  challenge: string;
  purpose: "registration" | "authentication";
  identityId?: string;
  identityVersion?: number;
  expiresAt: number;
}
export interface PasskeyAuthOptions extends PasskeyCeremonyOptions {
  challengeTtlSeconds?: number;
  getIdentity(id: string): PasskeyIdentity | undefined | Promise<PasskeyIdentity | undefined>;
  listCredentials(identityId?: string): PasskeyCredential[] | Promise<PasskeyCredential[]>;
  getCredential(credentialId: string): PasskeyCredential | undefined | Promise<PasskeyCredential | undefined>;
  saveChallenge(challenge: Readonly<PasskeyChallenge>): void | Promise<void>;
  /** Atomically consumes exactly one matching, unexpired intended-use challenge. */
  consumeChallenge(id: string, purpose: PasskeyChallenge["purpose"]): PasskeyChallenge | undefined | Promise<PasskeyChallenge | undefined>;
  /** Atomic registration/replacement and epoch check. Return the committed epoch if it changes. */
  saveCredential(credential: Readonly<PasskeyCredential>, expectedIdentityVersion: number): boolean | number | Promise<boolean | number>;
  /** CAS the old credential/counter AND current identity version before accepting login. */
  updateCredential(expected: Readonly<PasskeyCredential>, counter: number, expectedIdentityVersion: number): boolean | Promise<boolean>;
  allowAttempt(attempt: { action: PasskeyChallenge["purpose"]; request: Request; identityId?: string }): boolean | Promise<boolean>;
}

export function createPasskeyAuth(options: PasskeyAuthOptions) {
  const origin = authenticationOrigin(options.origin);
  const ceremonies = createPasskeyCeremonies(options);
  const ttl = options.challengeTtlSeconds ?? 300;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 600) throw new TypeError("Passkey challenges require a TTL between 1 and 600 seconds.");
  async function allow(req: Request, purpose: PasskeyChallenge["purpose"], identityId?: string) {
    requireAuthenticationOrigin(req, origin.origin);
    if (!await options.allowAttempt({ action: purpose, request: req, identityId })) throw new AuthBonusError("too_many_attempts", "Try again later.", 429);
  }
  async function identity(id: string) {
    const value = await options.getIdentity(id);
    if (!value) throw new AuthBonusError("identity_unavailable", "Identity is unavailable.", 401);
    validVersion(value.version);
    return value;
  }
  async function saveChallenge(challenge: string, purpose: PasskeyChallenge["purpose"], user?: PasskeyIdentity) {
    const record: PasskeyChallenge = {
      id: crypto.randomUUID(), challenge, purpose, expiresAt: Date.now() + ttl * 1000,
      ...(user ? { identityId: user.id, identityVersion: user.version } : {}),
    };
    await options.saveChallenge(record);
    return record.id;
  }
  async function consume(id: string, purpose: PasskeyChallenge["purpose"]) {
    if (typeof id !== "string" || id.length > 128) throw new AuthBonusError("challenge_invalid", "Challenge is invalid or expired.", 400);
    const value = await options.consumeChallenge(id, purpose);
    if (!value || value.id !== id || value.purpose !== purpose || value.expiresAt <= Date.now()) {
      throw new AuthBonusError("challenge_invalid", "Challenge is invalid or expired.", 400);
    }
    return value;
  }
  return {
    async beginRegistration(req: Request, authorizedIdentityId: string) {
      await allow(req, "registration", authorizedIdentityId);
      const user = await identity(authorizedIdentityId);
      const existing = await options.listCredentials(user.id);
      const registration = await ceremonies.beginRegistration(user, existing);
      return { challengeId: await saveChallenge(registration.challenge, "registration", user), options: registration };
    },
    async finishRegistration(req: Request, authorizedIdentityId: string, challengeId: string, response: RegistrationResponseJSON) {
      await allow(req, "registration", authorizedIdentityId);
      const challenge = await consume(challengeId, "registration");
      const user = await identity(authorizedIdentityId);
      if (challenge.identityId !== user.id || challenge.identityVersion !== user.version) throw new AuthBonusError("challenge_invalid", "Identity changed during registration.", 409);
      const verified = await ceremonies.verifyRegistration(response, challenge.challenge);
      const credential: PasskeyCredential = { identityId: user.id, ...verified.credential };
      const saved = await options.saveCredential(credential, user.version);
      if (saved === false) throw new AuthBonusError("credential_changed", "Passkey registration could not be saved.", 409);
      const version = typeof saved === "number" ? saved : user.version;
      validVersion(version);
      return { identity: { ...user, version }, credential };
    },
    async beginAuthentication(req: Request, identityId?: string) {
      await allow(req, "authentication", identityId);
      const user = identityId === undefined ? undefined : await identity(identityId);
      const credentials = await options.listCredentials(user?.id);
      const authentication = await ceremonies.beginAuthentication(credentials);
      return { challengeId: await saveChallenge(authentication.challenge, "authentication", user), options: authentication };
    },
    async finishAuthentication(req: Request, challengeId: string, response: AuthenticationResponseJSON) {
      await allow(req, "authentication");
      const challenge = await consume(challengeId, "authentication");
      if (!response || typeof response.id !== "string" || response.id.length > 2048) throw new AuthBonusError("authentication_failed", "Passkey authentication failed.", 401);
      const found = await options.getCredential(response.id);
      if (!found) throw new AuthBonusError("authentication_failed", "Passkey authentication failed.", 401);
      const user = await identity(found.identityId);
      if (challenge.identityId !== undefined && (challenge.identityId !== user.id || challenge.identityVersion !== user.version)) {
        throw new AuthBonusError("challenge_invalid", "Identity changed during authentication.", 409);
      }
      const verified = await ceremonies.verifyAuthentication(response, challenge.challenge, found);
      if (!await options.updateCredential(found, verified.counter, user.version)) {
        throw new AuthBonusError("authentication_failed", "Passkey authentication failed.", 401);
      }
      return { identity: user, credentialId: found.credentialId };
    },
  };
}
