import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type AuthenticatorTransport,
} from "@simplewebauthn/server";
import { AuthBonusError, authenticationOrigin } from "./common";

export interface PasskeyCeremonyOptions {
  origin: string;
  rpID: string;
  rpName: string;
  requireUserVerification?: boolean;
}
export interface PasskeyCeremonyIdentity {
  userHandle: Uint8Array<ArrayBuffer>;
  username: string;
  displayName?: string;
}
export interface PasskeyCeremonyDescriptor {
  credentialId: string;
  transports?: readonly string[];
}
export interface PasskeyCeremonyCredential extends PasskeyCeremonyDescriptor {
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
}

function transports(values?: readonly string[]): AuthenticatorTransport[] {
  return (values ?? []).filter((value): value is AuthenticatorTransport =>
    ["ble", "hybrid", "internal", "nfc", "usb"].includes(value));
}

/** Stateless ceremonies for apps retaining their own challenge/cookie/account protocols. */
export function createPasskeyCeremonies(options: PasskeyCeremonyOptions) {
  const origin = authenticationOrigin(options.origin);
  if (!options.rpID || !(origin.hostname === options.rpID || origin.hostname.endsWith(`.${options.rpID}`))) {
    throw new TypeError("Passkey RP ID must match the authentication origin.");
  }
  const requireUserVerification = options.requireUserVerification !== false;
  const userVerification = requireUserVerification ? "required" : "preferred";
  return {
    async beginRegistration(user: PasskeyCeremonyIdentity, credentials: readonly PasskeyCeremonyDescriptor[] = []) {
      return await generateRegistrationOptions({
        rpName: options.rpName, rpID: options.rpID, userID: user.userHandle, userName: user.username,
        userDisplayName: user.displayName ?? user.username, attestationType: "none",
        excludeCredentials: credentials.map(value => ({ id: value.credentialId, transports: transports(value.transports) })),
        authenticatorSelection: { residentKey: "preferred", userVerification },
      });
    },
    async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response, expectedChallenge, expectedOrigin: origin.origin, expectedRPID: options.rpID, requireUserVerification,
        });
      } catch {
        throw new AuthBonusError("registration_failed", "Passkey registration failed.", 400);
      }
      if (!verified.verified || !verified.registrationInfo) throw new AuthBonusError("registration_failed", "Passkey registration failed.", 400);
      const { credential, credentialDeviceType: deviceType, credentialBackedUp: backedUp } = verified.registrationInfo;
      return {
        credential: {
          credentialId: credential.id, publicKey: credential.publicKey, counter: credential.counter,
          transports: transports(credential.transports ?? response.response.transports),
        },
        deviceType, backedUp,
      };
    },
    async beginAuthentication(credentials: readonly PasskeyCeremonyDescriptor[] = []) {
      return await generateAuthenticationOptions({
        rpID: options.rpID, userVerification,
        allowCredentials: credentials.map(value => ({ id: value.credentialId, transports: transports(value.transports) })),
      });
    },
    async verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string, credential: PasskeyCeremonyCredential) {
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response, expectedChallenge, expectedOrigin: origin.origin, expectedRPID: options.rpID, requireUserVerification,
          credential: {
            id: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter,
            transports: transports(credential.transports),
          },
        });
      } catch {
        throw new AuthBonusError("authentication_failed", "Passkey authentication failed.", 401);
      }
      if (!verified.verified) throw new AuthBonusError("authentication_failed", "Passkey authentication failed.", 401);
      return { counter: verified.authenticationInfo.newCounter };
    },
  };
}
