import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/** Approved real WebAuthn fixture: real key material and signatures, no verification bypass. */
export async function authenticator(origin: string, rpId: string) {
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const clientData = (challenge: string, type: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    registration(challenge: string): RegistrationResponseJSON {
      const key = new Map<number, number | Uint8Array>([
        [1, 2], [3, -7], [-1, 1], [-2, publicKey.slice(1, 33)], [-3, publicKey.slice(33)],
      ]);
      const data = Buffer.concat([
        rpHash, new Uint8Array([0x45]), new Uint8Array(4), new Uint8Array(16),
        new Uint8Array([0, credential.length]), credential, isoCBOR.encode(key),
      ]);
      return {
        id: base64(credential), rawId: base64(credential), type: "public-key",
        response: { clientDataJSON: base64(clientData(challenge, "webauthn.create")),
          attestationObject: base64(isoCBOR.encode(new Map<string, string | Map<never, never> | Uint8Array>([
            ["fmt", "none"], ["attStmt", new Map<never, never>()], ["authData", data],
          ]))), transports: ["internal"] },
        authenticatorAttachment: "platform", clientExtensionResults: {},
      };
    },
    async authentication(challenge: string): Promise<AuthenticationResponseJSON> {
      const data = Buffer.concat([rpHash, new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 1])]);
      const client = clientData(challenge, "webauthn.get");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", client));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.concat([data, hash])));
      const integer = (part: Uint8Array) => {
        const start = part.findIndex(byte => byte !== 0);
        const value = part.slice(start < 0 ? part.length - 1 : start);
        const padded = value[0]! >= 0x80 ? Buffer.concat([new Uint8Array([0]), value]) : value;
        return Buffer.concat([new Uint8Array([2, padded.length]), padded]);
      };
      const content = Buffer.concat([integer(raw.slice(0, 32)), integer(raw.slice(32))]);
      return {
        id: base64(credential), rawId: base64(credential), type: "public-key", clientExtensionResults: {},
        response: { authenticatorData: base64(data), clientDataJSON: base64(client),
          signature: base64(Buffer.concat([new Uint8Array([0x30, content.length]), content])) },
      };
    },
  };
}
